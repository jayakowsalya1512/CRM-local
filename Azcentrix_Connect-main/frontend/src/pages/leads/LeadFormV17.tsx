// Lead form – Bidwise prototype v17 formPage('leads') (/leads/new, /leads/:id/edit).
// Same layout as the prototype: header tile · sections (Basic information / Contact & location / Commercials /
// Ownership & timeline / Additional information) · Summary / Completeness / approval & duplicate notes / Tips · sticky
// action bar. Every dropdown is read live from its master (customers, contacts, lead sources, products, users) –
// nothing is hard-coded – and the backend re-validates each master id before saving.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { useAuthStore } from '@/store'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { inferRule, mapApiErrors, todayISO, type FieldSpec, type Val } from '@/utils/validation'
import Lookup from './Lookup'
import { errMsg, inr, leadApi, masters, useMaster, type Meta, type Opt } from './leadApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './leads.css'

type Sec = 'Basic information' | 'Contact & location' | 'Commercials' | 'Ownership & timeline' | 'Additional information'
const SECS: [Sec, string][] = [['Basic information', 'file'], ['Contact & location', 'users'], ['Commercials', 'card'], ['Ownership & timeline', 'cal'], ['Additional information', 'layout']]
const TIPS = ['Add the decision-maker and expected value – it drives lead score and routing.', 'Leads from tender portals should carry the tender reference in Interest.', 'A lead converts to a deal or tender and keeps one journey ID.']
const nowT = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

interface V {
  customer: Opt | null; contact: Opt | null; source: Opt | null; value: string; product: Opt | null; owner: Opt | null; follow_up: string
  custom: Record<string, string | boolean>
}
const blank = (me: Opt | null): V => ({ customer: null, contact: null, source: null, value: '', product: null, owner: me, follow_up: '', custom: {} })
type Key = 'customer' | 'contact' | 'source' | 'value' | 'product' | 'owner' | 'follow_up'
// API field (LeadIn) → form field
const API_MAP: Record<string, string> = {
  customer_id: 'customer', contact_id: 'contact', source_id: 'source', est_value: 'value', product_id: 'product', assigned_to: 'owner', follow_up: 'follow_up', custom_data: 'cf_',
}

export default function LeadFormV17() {
  const { id: idParam } = useParams()
  const editId = idParam ? Number(idParam) : null
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const user = useAuthStore(s => s.user)
  const tenant = useAuthStore(s => s.tenant_slug)
  const { fields: cfg } = useFormConfig('leads')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [v, setV] = useState<V>(() => blank(null))
  const [orig, setOrig] = useState<V | null>(null)
  const [ref, setRef] = useState('')
  const fe = useFieldErrors()
  const errs = fe.errors
  const [busy, setBusy] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [ready, setReady] = useState(!editId)
  const [draftNote, setDraftNote] = useState('')
  const [restored, setRestored] = useState(false)
  const [dups, setDups] = useState<{ id: number; ref: string; title: string; same_product: boolean }[]>([])
  const refs = useRef<Record<string, HTMLElement | null>>({})
  const dirty = useRef(false)
  const draftKey = `lead-form-draft:${tenant || ''}:${user?.id || ''}`

  // ── masters (live) ──
  const [custQ, setCustQ] = useState('')
  const customers = useMaster(() => masters.customers(custQ), [custQ])
  const contacts = useMaster(v.customer ? () => masters.contacts(v.customer!.id) : null, [v.customer?.id])
  const sources = useMaster(masters.sources)
  const products = useMaster(masters.products)
  const users = useMaster(masters.users)

  useEffect(() => {
    leadApi.meta().then(m => { setMeta(m); if (!editId) setV(s => s.owner || dirty.current ? s : { ...s, owner: m.me }) })
      .catch(e => setLoadErr(errMsg(e, 'Could not open the lead form')))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const me: Opt | null = meta?.me ?? null
  useEffect(() => {
    if (!editId) {
      let d: V | null = null
      try { d = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { /* private mode */ }
      if (d && (d.customer || d.value || d.product || d.source || d.follow_up)) { setV({ ...blank(me), ...d }); setRestored(true) }
      return
    }
    let live = true
    leadApi.get(editId).then(d => {
      if (!live) return
      const f = d.form
      const val: V = {
        customer: f.customer_id ? { id: f.customer_id, name: f.customer_name || d.company } : null,
        contact: f.contact_id ? { id: f.contact_id, name: f.contact_person || '' } : null,
        source: f.source_id ? { id: f.source_id, name: (d.panels[0]?.f.find(x => x[0] === 'Source')?.[1] as string) || '' } : null,
        value: f.est_value ? String(f.est_value) : '', product: f.product_id ? { id: f.product_id, name: f.product_name || '' } : null,
        owner: f.assigned_to ? { id: f.assigned_to, name: (d.panels[2]?.f.find(x => x[0] === 'Owner')?.[1] as string) || '' } : null,
        follow_up: f.follow_up || '',
        custom: Object.fromEntries(Object.entries(f.custom_data || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')])),
      }
      setV(val); setOrig(val); setRef(d.ref); setReady(true)
    }).catch(e => { if (live) setLoadErr(errMsg(e, 'Could not open this lead')) })
    return () => { live = false }
  }, [editId]) // eslint-disable-line react-hooks/exhaustive-deps

  // a contact from a different company is never kept
  useEffect(() => {
    if (!v.contact || !contacts.items) return
    if (!contacts.items.some(c => c.id === v.contact!.id) && !(orig?.contact?.id === v.contact.id && orig?.customer?.id === v.customer?.id))
      setV(s => ({ ...s, contact: null }))
  }, [contacts.items]) // eslint-disable-line react-hooks/exhaustive-deps

  // duplicate detection (open leads of the same company, same product first)
  useEffect(() => {
    if (!v.customer) { setDups([]); return }
    const t = setTimeout(() => { leadApi.duplicates(v.customer!.id, v.product?.id ?? null, editId ?? undefined).then(setDups).catch(() => setDups([])) }, 250)
    return () => clearTimeout(t)
  }, [v.customer?.id, v.product?.id, editId]) // eslint-disable-line react-hooks/exhaustive-deps

  // draft autosave (new leads only, once the user has changed something)
  useEffect(() => {
    if (editId || !dirty.current) return
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify(v)); setDraftNote(`Draft saved ${nowT()}`) } catch { /* private mode */ } }, 600)
    return () => clearTimeout(t)
  }, [v, editId, draftKey])

  const customs = cfg.filter(f => f.is_custom && f.is_visible).sort((a, b) => a.sort_order - b.sort_order)
  const cfgReq = (k: string) => cfg.some(f => !f.is_custom && f.field_key === k && f.is_required)
  const REQ: Record<Key, boolean> = { customer: true, contact: cfgReq('contact_person'), source: cfgReq('source_id'), value: cfgReq('est_value'), product: cfgReq('products'), owner: cfgReq('assigned_to'), follow_up: cfgReq('follow_up') }

  type F = { id: string; label: string; sec: Sec; req: boolean; w?: 2; filled: boolean; node: (bad: boolean) => ReactNode }
  // validation rule per field (custom fields: inferred from their Form Builder type / label + is_required)
  const spec = (id: string): FieldSpec | undefined => {
    if (id.startsWith('cf_')) {
      const c = customs.find(x => x.field_key === id.slice(3))
      return c ? { label: c.label, required: c.is_required, rule: inferRule(c.field_key, c.label, c.field_type) } : undefined
    }
    switch (id as Key) {
      case 'customer': return { label: 'Company', rule: 'select', required: true }
      case 'product': return { label: 'Product', rule: 'select', required: REQ.product }
      case 'contact': return { label: 'Contact person', rule: 'select', required: REQ.contact }
      case 'source': return { label: 'Source', rule: 'select', required: REQ.source }
      case 'owner': return { label: 'Owner', rule: 'select', required: REQ.owner }
      case 'value': return { label: 'Expected value', rule: 'amount', required: REQ.value }
      // a new lead's follow-up cannot be in the past; an existing lead is never blocked by its old date
      case 'follow_up': return { label: 'Next follow-up', rule: 'date', required: REQ.follow_up, ...(editId ? {} : { minDate: todayISO(), dateLabel: { min: 'today' } }) }
    }
    return undefined
  }
  const valOf = (id: string, x: V = v): Val => id.startsWith('cf_') ? x.custom[id.slice(3)] : (x[id as Key] as Val)
  const leave = (id: string) => fe.blur(id, valOf(id), spec(id))
  const set = <K extends keyof V>(k: K, x: V[K]) => { dirty.current = true; setV(s => ({ ...s, [k]: x })); fe.change(k as string, x as Val, spec(k as string)) }
  const setCustom = (k: string, x: string | boolean) => { dirty.current = true; setV(s => ({ ...s, custom: { ...s.custom, [k]: x } })); fe.change(`cf_${k}`, x, spec(`cf_${k}`)) }
  const lk = (id: Key, m: ReturnType<typeof useMaster>, extra: Partial<Parameters<typeof Lookup>[0]> = {}) => (bad: boolean) =>
    <Lookup id={`lf-${id}`} value={(v[id] as Opt | null)?.id ?? null} label={(v[id] as Opt | null)?.name} items={m.items} error={m.error} onRetry={m.reload} bad={bad}
      inputRef={el => { refs.current[id] = el }} onChange={o => set(id, o as never)} onBlur={() => leave(id)} {...extra} />

  const fields: F[] = useMemo(() => [
    { id: 'customer', label: 'Company', sec: 'Basic information', req: true, w: 2, filled: !!v.customer,
      node: lk('customer', customers, { onSearch: setCustQ, placeholder: 'Search customers…', emptyText: 'No customers you can work with', clearable: false,
        onChange: o => { dirty.current = true; setV(s => ({ ...s, customer: o, contact: o && s.customer?.id === o.id ? s.contact : null })); fe.change('customer', o, spec('customer')) } }) },
    { id: 'product', label: 'Interested in', sec: 'Basic information', req: REQ.product, filled: !!v.product, node: lk('product', products, { emptyText: 'No active products or services in Masters' }) },
    { id: 'contact', label: 'Contact person', sec: 'Contact & location', req: REQ.contact, filled: !!v.contact,
      node: lk('contact', contacts, { disabled: !v.customer, disabledText: 'Choose a company first', emptyText: 'This company has no active contacts' }) },
    { id: 'source', label: 'Source', sec: 'Contact & location', req: REQ.source, filled: !!v.source, node: lk('source', sources, { emptyText: 'No active lead sources in Masters' }) },
    { id: 'value', label: 'Expected value', sec: 'Commercials', req: REQ.value, filled: !!v.value,
      node: bad => <div className="cur-in"><span>₹</span><input id="lf-value" ref={el => { refs.current.value = el }} className={`in ${bad ? 'err' : ''}`} type="number" min={0} step="any" inputMode="decimal"
        value={v.value} onChange={e => set('value', e.target.value)} onBlur={() => leave('value')} aria-invalid={bad || undefined} /></div> },
    { id: 'owner', label: 'Owner', sec: 'Ownership & timeline', req: REQ.owner, filled: !!v.owner, node: lk('owner', users, { emptyText: 'No active users' }) },
    { id: 'follow_up', label: 'Next follow-up', sec: 'Ownership & timeline', req: REQ.follow_up, filled: !!v.follow_up,
      node: bad => <input id="lf-follow_up" ref={el => { refs.current.follow_up = el }} className={`in ${bad ? 'err' : ''}`} type="date" value={v.follow_up} onChange={e => set('follow_up', e.target.value)}
        onBlur={() => leave('follow_up')} aria-invalid={bad || undefined} /> },
    ...customs.map((c: FormFieldConfig): F => {
      const k = c.field_key, val = v.custom[k], id = `cf_${k}`
      const opts = (c.options || []).map(o => typeof o === 'string' ? { v: o, l: o } : { v: o.value, l: o.label })
      return { id, label: c.label, sec: 'Additional information', req: c.is_required, w: c.col_span === 2 || c.field_type === 'textarea' ? 2 : undefined,
        filled: val !== undefined && val !== '' && val !== false,
        node: bad => {
          const p = { id: `lf-${id}`, ref: (el: HTMLElement | null) => { refs.current[id] = el }, className: `in ${bad ? 'err' : ''}`, onBlur: () => leave(id), 'aria-invalid': bad || undefined }
          if (c.field_type === 'select') return <select {...p} value={String(val ?? '')} onChange={e => setCustom(k, e.target.value)}><option value="">Select…</option>{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          if (c.field_type === 'textarea') return <textarea {...p} rows={3} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
          if (c.field_type === 'checkbox') return <label className="row" style={{ gap: 6 }}><input id={p.id} ref={p.ref} type="checkbox" checked={!!val} onChange={e => setCustom(k, e.target.checked)} onBlur={p.onBlur} aria-invalid={p['aria-invalid']} /> Yes</label>
          return <input {...p} type={c.field_type === 'phone' ? 'tel' : c.field_type} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
        } }
    }),
  ], [v, customers, contacts, sources, products, users, customs, errs]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = SECS.map(([s, i]) => [s, i, fields.filter(f => f.sec === s)] as const).filter(g => g[2].length)
  const miss = fields.filter(f => f.req && !f.filled)
  const pct = Math.round(fields.filter(f => f.filled).length / Math.max(fields.length, 1) * 100)
  const show = (f: F, x: V | null) => {
    if (!x) return ''
    if (f.id.startsWith('cf_')) return String(x.custom[f.id.slice(3)] ?? '')
    const y = x[f.id as Key]
    return y && typeof y === 'object' ? (y as Opt).name : String(y ?? '')
  }
  const changes = orig ? fields.filter(f => {
    if (f.id.startsWith('cf_')) return String(orig.custom[f.id.slice(3)] ?? '') !== String(v.custom[f.id.slice(3)] ?? '')
    const a = orig[f.id as Key], b = v[f.id as Key]
    return (a && typeof a === 'object' ? (a as Opt).id : String(a ?? '')) !== (b && typeof b === 'object' ? (b as Opt).id : String(b ?? ''))
  }) : []
  const approval = meta ? (editId ? (changes.length ? meta.approval.update : null) : meta.approval.create) : null

  const jump = (id: string) => { const el = refs.current[id]; if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const reset = () => { setV(blank(me)); setRestored(false); setDraftNote(''); dirty.current = false; fe.clear(); window.scrollTo(0, 0); setTimeout(() => refs.current.customer?.focus(), 0) }

  const save = async (again = false) => {
    const bad = fe.validateAll(Object.fromEntries(fields.map(f => [f.id, valOf(f.id)])), Object.fromEntries(fields.map(f => [f.id, spec(f.id)])))
    if (Object.keys(bad).length) { const first = fields.find(f => bad[f.id]); if (first) jump(first.id); return }
    const custom: Record<string, unknown> = { ...(orig ? Object.fromEntries(Object.entries(orig.custom)) : {}), ...v.custom }
    const body = {
      customer_id: v.customer!.id, contact_id: v.contact?.id ?? null, source_id: v.source?.id ?? null, est_value: v.value ? Number(v.value) : null,
      product_id: v.product?.id ?? null, assigned_to: v.owner?.id ?? null, follow_up: v.follow_up || null, custom_data: Object.keys(custom).length ? custom : null,
    }
    setBusy(true)
    try {
      const r: { id: number; approval_status?: string | null } = editId ? await leadApi.update(editId, body) : await leadApi.create(body)
      const pending = String(r.approval_status || '') === 'pending'
      if (!editId) { dirty.current = false; try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
      success(editId ? 'Lead updated' : `Lead created${pending ? ' – waiting for approval' : ''}`)
      if (again) reset()
      else navigate(`/leads?open=${editId || r.id}`)
    } catch (e) {
      // server-side field errors land under their fields; anything else is a toast
      const fx = mapApiErrors(e, API_MAP), known = Object.fromEntries(Object.entries(fx).filter(([k]) => fields.some(f => f.id === k)))
      if (Object.keys(known).length) { fe.setErrors(x => ({ ...x, ...known })); const first = fields.find(f => known[f.id]); if (first) jump(first.id) }
      else error(errMsg(e, editId ? 'Could not save the lead' : 'Could not create the lead'))
    }
    finally { setBusy(false) }
  }
  const cancel = () => navigate(editId ? `/leads?open=${editId}` : '/leads')
  const discard = () => { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } reset(); warning('Draft discarded') }

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/leads')}>Leads</a></div><div className="panel"><div className="empty">{loadErr}</div></div></div>
  if (!ready || !meta) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/leads')}>Leads</a> / {editId ? '…' : 'New'}</div><div className="empty">Loading…</div></div>
  if (editId ? false : !meta.can.create) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/leads')}>Leads</a></div><div className="panel"><div className="empty">You do not have permission to create leads.</div></div></div>

  const title = v.customer?.name || ''
  return (
    <div className="bwi fpage">
      <div className="crumb"><a onClick={() => navigate('/leads')}>Leads</a> / {editId ? ref || '…' : 'New'}</div>
      <div className="fph">
        <div className="fpi"><Ic n="funnel" size={22} /></div>
        <div className="fl"><h1>{editId ? 'Edit' : 'New'} lead</h1>
          <div className="mu">{editId ? 'Update the details below. Changes are highlighted and checked against your approval rules.' : 'Fill in the essentials – you can add more detail any time. Fields marked * are required.'}
            {restored && <> · <b>Draft restored</b> · <a onClick={discard}>Discard</a></>}</div></div>
      </div>
      <div className="fp-grid">
        <div className="fp-main">
          {groups.map(([g, icon, L]) => <section className="fsec" key={g}>
            <div className="fsh"><span className="fsi"><Ic n={icon} /></span><b>{g}</b><small className="mu">{L.length} field{L.length > 1 ? 's' : ''}</small></div>
            <div className="fg">{L.map(f => <div key={f.id} className={`${f.w === 2 ? 'f1' : ''} ${orig && changes.includes(f) ? 'chg' : ''}`}>
              <label htmlFor={`lf-${f.id}`}>{f.label}{f.req && <b> *</b>}</label>{f.node(!!errs[f.id])}<FieldError id={`lf-${f.id}`} msg={errs[f.id]} /></div>)}</div>
          </section>)}
        </div>
        <aside className="fp-side">
          <div className="panel"><div className="ph"><Ic n="spark" /> Summary</div><div className="pb">
            <div className="b" style={{ fontSize: 15, minHeight: 20, fontWeight: 600 }}>{title || <span className="mu">Untitled</span>}</div>
            <div className="mu" style={{ fontSize: 12 }}>{[v.product?.name, v.contact?.name].filter(Boolean).join(' · ')}</div>
            <div className="mt row wrap" style={{ gap: 6 }}>{v.value ? <span className="pill ac">{inr(Number(v.value))}</span> : null}{v.source ? <span className="pill mu">{v.source.name}</span> : null}{v.owner ? <span className="pill inf">{v.owner.name}</span> : null}</div>
          </div></div>
          <div className="panel mt"><div className="ph"><Ic n="check" /> Completeness</div><div className="pb">
            <div className="pm"><i style={{ width: `${pct}%`, background: miss.length ? 'var(--bw-wa)' : 'var(--bw-ok)' }} /></div>
            <div className="mt" style={{ fontSize: 12 }}>{miss.length
              ? <><span className="twarn">{miss.length} required:</span> {miss.map((f, i) => <span key={f.id}>{i ? ', ' : ''}<a onClick={() => jump(f.id)}>{f.label}</a></span>)}</>
              : <span className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> All required fields are filled</span>}{!miss.length && <> · {pct}% complete</>}</div>
          </div></div>
          {editId && changes.length > 0 && <div className="panel mt"><div className="ph"><Ic n="edit" /> {changes.length} change{changes.length > 1 ? 's' : ''}</div><div className="pb z">
            <table className="t"><tbody>{changes.map(f => <tr key={f.id}><td>{f.label}</td><td className="mu">{show(f, orig) || '—'}</td><td><b>{show(f, v) || '—'}</b></td></tr>)}</tbody></table></div></div>}
          {approval && <div className="note mt"><Ic n="lock" /> <b>Approval needed.</b> {editId ? 'These changes will be held until' : 'After creating, this lead waits for'} {approval.join(' › ') || 'the configured approvers'}{editId ? ' approve.' : '.'}</div>}
          {dups.length > 0 && <div className="note mt" style={{ borderColor: 'var(--bw-wa)' }}><Ic n="alert" /> <b>Possible duplicate</b> – {title} already has {dups.length} open lead{dups.length > 1 ? 's' : ''}<br />
            {dups.slice(0, 3).map(d => <div key={d.id}><a onClick={() => navigate(`/leads?open=${d.id}`)}>{d.ref} – {d.title.slice(0, 40)}</a>{d.same_product && <small className="mu"> · same product</small>}</div>)}</div>}
          <div className="panel mt"><div className="ph"><Ic n="spark" /> Tips</div><div className="pb"><ul className="tips">{TIPS.map(t => <li key={t}>{t}</li>)}</ul></div></div>
        </aside>
      </div>
      <div className="fmbar">
        <span className="mu">{editId ? `Editing ${ref}` : draftNote ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> {draftNote}</span> : 'Draft saves automatically'}</span>
        <span className="fl" />
        <button type="button" className="btn" onClick={cancel} disabled={busy}>Cancel</button>
        {editId
          ? <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Saving…' : 'Save changes'}</button>
          : <><button type="button" className="btn" onClick={() => save(true)} disabled={busy}>Create &amp; add another</button>
            <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Creating…' : 'Create lead'}</button></>}
      </div>
    </div>
  )
}
