// Quote form – prototype v17 formPage('quotes') (/quotations/new, /quotations/:id/edit = "Edit header"). Header tile ·
// sections Basic information (Subject, Customer, Enquiry reference, Valid till) / Ownership & timeline (Owner) /
// Additional information (Form Builder fields), side panels Summary / Completeness / duplicate note / Tips, sticky
// Cancel · Create & add another · Create quote. ?deal=<id> links the quote to a deal (its products become the lines),
// ?customer=<id> pre-selects the customer.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { useAuthStore } from '@/store'
import Lookup from '@/pages/leads/Lookup'
import { masters, useMaster, type Opt } from '@/pages/leads/leadApi'
import api from '@/services/api'
import { errMsg, quoteApi, todayIso, type Meta, type Row } from './quoteApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { inferRule, mapApiErrors, type FieldSpec, type Val } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './quotes.css'

type Sec = 'Basic information' | 'Ownership & timeline' | 'Additional information'
const SECS: [Sec, string][] = [['Basic information', 'file'], ['Ownership & timeline', 'cal'], ['Additional information', 'layout']]
const TIPS = ['Add line items after saving – revisions are tracked automatically.', 'Validity defaults from Settings → Quotes.']
const nowT = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const addDays = (n: number) => { const t = new Date(); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }

interface V { subject: string; customer: Opt | null; enquiry: string; valid: string; owner: Opt | null; custom: Record<string, string | boolean> }
// validation rule per built-in field (backend QuoteIn); custom fields are inferred from their type / label
const RULE: Record<string, Partial<FieldSpec>> = {
  subject: { rule: 'text', min: 3, max: 500 }, customer: { rule: 'select' }, enquiry: { rule: 'text', max: 120 }, valid: { rule: 'date' }, owner: { rule: 'select' },
}
// API field → form field
const API_MAP: Record<string, string> = { customer_id: 'customer', valid_till: 'valid', owner_id: 'owner', custom_data: 'cf_' }
const blank = (owner: Opt | null, valid = ''): V => ({ subject: '', customer: null, enquiry: '', valid, owner, custom: {} })

export default function QuoteFormV17() {
  const { id: idParam } = useParams()
  const editId = idParam ? Number(idParam) : null
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const user = useAuthStore(s => s.user)
  const tenant = useAuthStore(s => s.tenant_slug)
  const { fields: cfg } = useFormConfig('quotations')
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
  const [dups, setDups] = useState<Row[]>([])
  const [deal, setDeal] = useState<{ id: number; name: string } | null>(null)
  const refs = useRef<Record<string, HTMLElement | null>>({})
  const dirty = useRef(false)
  const draftKey = `quote-form-draft:${tenant || ''}:${user?.id || ''}`

  const [custQ, setCustQ] = useState('')
  const customers = useMaster(() => quoteApi.customers(custQ), [custQ])
  const users = useMaster(masters.users)
  const validDefault = (m: Meta | null) => m?.config.validity_days ? addDays(m.config.validity_days) : ''

  useEffect(() => {
    quoteApi.meta().then(m => {
      setMeta(m)
      if (!editId) setV(s => dirty.current || restored ? s : { ...s, owner: s.owner || m.me, valid: s.valid || validDefault(m) })
    }).catch(e => setLoadErr(errMsg(e, 'Could not open the quote form')))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editId) {
      let live = true
      quoteApi.get(editId).then(d => {
        if (!live) return
        const f = d.form
        const val: V = { subject: f.subject, customer: f.customer_id ? { id: f.customer_id, name: f.customer_name } : null, enquiry: f.enquiry, valid: f.valid_till || '',
          owner: f.owner_id ? { id: f.owner_id, name: f.owner_name } : null,
          custom: Object.fromEntries(Object.entries(f.custom_data || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')])) }
        setV(val); setOrig(val); setRef(d.ref); setReady(true)
      }).catch(e => { if (live) setLoadErr(errMsg(e, 'Could not open this quote')) })
      return () => { live = false }
    }
    const dealId = Number(sp.get('deal')) || null       // Deal → "Create quotation"
    if (dealId) {
      api.get(`/deals/${dealId}`).then(r => {
        const d = r.data
        dirty.current = true
        setDeal({ id: dealId, name: d.name })
        setV(s => ({ ...s, subject: s.subject || d.name, customer: d.customer_id ? { id: d.customer_id, name: d.customer || '' } : s.customer,
          owner: d.form?.owner_id ? { id: d.form.owner_id, name: d.form.owner_name || '' } : s.owner }))
      }).catch(e => error(errMsg(e, 'Could not load that deal')))
      return
    }
    const cust = Number(sp.get('customer')) || null
    let draft: V | null = null
    try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { /* private mode */ }
    if (!cust && draft && (draft.subject || draft.customer)) { setV(s => ({ ...s, ...draft })); setRestored(true) }
    if (cust) quoteApi.customers('').then(L => { const c = L.find(x => x.id === cust); if (c) setV(s => ({ ...s, customer: c })) }).catch(() => { /* lookup still works */ })
  }, [editId]) // eslint-disable-line react-hooks/exhaustive-deps

  // prototype "Possible duplicate": open quotes of the same customer with a matching subject
  useEffect(() => {
    const key = v.subject.trim().toLowerCase()
    if (!v.customer || key.length <= 3) { setDups([]); return }
    const t = setTimeout(() => {
      quoteApi.list({ view: 'All', stage: '', q: '', f: { customer: v.customer!.name }, adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 200 })
        .then(r => setDups(r.items.filter(x => x.id !== editId && x.stage_kind === 'open' && (x.subject.toLowerCase() === key || (key.length > 6 && x.subject.toLowerCase().includes(key)))).slice(0, 3)))
        .catch(() => setDups([]))
    }, 350)
    return () => clearTimeout(t)
  }, [v.customer?.id, v.subject, editId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editId || !dirty.current || deal) return
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify(v)); setDraftNote(`Draft saved ${nowT()}`) } catch { /* private mode */ } }, 600)
    return () => clearTimeout(t)
  }, [v, editId, draftKey, deal])

  const customs = cfg.filter(f => f.is_custom && f.is_visible).sort((a, b) => a.sort_order - b.sort_order)
  const cfgReq = (k: string) => cfg.some(f => !f.is_custom && f.field_key === k && f.is_required)
  // validation: built-in fields use RULE + their required flag, Form Builder fields are inferred from key / label / type.
  // "Valid till" may not be in the past on a NEW quote only – an existing quote is never blocked by its old date.
  const specOf = (id: string, label: string, req: boolean): FieldSpec | undefined => {
    if (id.startsWith('cf_')) {
      const c = customs.find(x => `cf_${x.field_key}` === id); if (!c) return undefined
      return { label: c.label, required: c.is_required, rule: inferRule(c.field_key, c.label, c.field_type) }
    }
    if (!RULE[id]) return undefined
    return { label, required: req, ...RULE[id], ...(id === 'valid' && !editId ? { minDate: todayIso(), dateLabel: { min: 'today' } } : {}) }
  }
  const valOf = (id: string, x: V = v): Val => id.startsWith('cf_') ? x.custom[id.slice(3)] : (x as unknown as Record<string, Val>)[id]
  const check = (id: string, mode: 'change' | 'blur', x: V = v) => {
    const f = fields.find(y => y.id === id); if (!f) return   // `fields` is declared below; handlers only run after render
    const sp = specOf(id, f.label, f.req); if (!sp) return
    if (mode === 'change') fe.change(id, valOf(id, x), sp); else fe.blur(id, valOf(id, x), sp)
  }
  const leave = (id: string) => check(id, 'blur')
  const set = <K extends keyof V>(k: K, x: V[K]) => {
    dirty.current = true; const next = { ...v, [k]: x }; setV(s => ({ ...s, [k]: x }))
    check(k as string, typeof x === 'object' ? 'blur' : 'change', next)   // picking from a lookup counts as leaving the field
  }
  const setCustom = (k: string, x: string | boolean) => { dirty.current = true; const next = { ...v, custom: { ...v.custom, [k]: x } }; setV(s => ({ ...s, custom: { ...s.custom, [k]: x } })); check(`cf_${k}`, 'change', next) }
  const aria = (id: string) => ({ 'aria-invalid': errs[id] ? true : undefined, 'aria-describedby': errs[id] ? `qf-${id}-err` : undefined })

  type F = { id: string; label: string; sec: Sec; req: boolean; w?: 2; help?: string; filled: boolean; node: (bad: boolean) => ReactNode }
  const fields: F[] = useMemo(() => !meta ? [] : [
    { id: 'subject', label: 'Subject', sec: 'Basic information', req: true, w: 2, filled: !!v.subject.trim(),
      node: bad => <input id="qf-subject" ref={el => { refs.current.subject = el }} className={`in ${bad ? 'err' : ''}`} maxLength={500} value={v.subject} onChange={e => set('subject', e.target.value)} onBlur={() => leave('subject')} {...aria('subject')} /> },
    { id: 'customer', label: 'Customer', sec: 'Basic information', req: true, filled: !!v.customer,
      node: bad => <Lookup id="qf-customer" value={v.customer?.id ?? null} label={v.customer?.name} items={customers.items} error={customers.error} onRetry={customers.reload} onSearch={setCustQ}
        placeholder="Select customer…" emptyText="No customers you can work with" clearable={false} bad={bad} inputRef={el => { refs.current.customer = el }} onChange={o => set('customer', o)} /> },
    { id: 'enquiry', label: 'Enquiry reference', sec: 'Basic information', req: cfgReq('enquiry'), filled: !!v.enquiry.trim(),
      node: bad => <input id="qf-enquiry" ref={el => { refs.current.enquiry = el }} className={`in ${bad ? 'err' : ''}`} maxLength={120} value={v.enquiry} onChange={e => set('enquiry', e.target.value)} onBlur={() => leave('enquiry')} {...aria('enquiry')} /> },
    { id: 'valid', label: 'Valid till', sec: 'Basic information', req: cfgReq('valid_until'), filled: !!v.valid,
      node: bad => <input id="qf-valid" ref={el => { refs.current.valid = el }} className={`in ${bad ? 'err' : ''}`} type="date" min={editId ? undefined : todayIso()} value={v.valid} onChange={e => set('valid', e.target.value)} onBlur={() => leave('valid')} {...aria('valid')} /> },
    { id: 'owner', label: 'Owner', sec: 'Ownership & timeline', req: cfgReq('owner'), filled: !!v.owner,
      node: bad => <Lookup id="qf-owner" value={v.owner?.id ?? null} label={v.owner?.name} items={users.items} error={users.error} onRetry={users.reload} bad={bad}
        inputRef={el => { refs.current.owner = el }} emptyText="No active users" onChange={o => set('owner', o)} /> },
    ...customs.map((c: FormFieldConfig): F => {
      const k = c.field_key, val = v.custom[k], id = `cf_${k}`
      const opts = (c.options || []).map(o => typeof o === 'string' ? { v: o, l: o } : { v: o.value, l: o.label })
      return { id, label: c.label, sec: 'Additional information', req: c.is_required, w: c.col_span === 2 || c.field_type === 'textarea' ? 2 : undefined,
        filled: val !== undefined && val !== '' && val !== false,
        node: bad => {
          const p = { id: `qf-${id}`, ref: (el: HTMLElement | null) => { refs.current[id] = el }, className: `in ${bad ? 'err' : ''}`, onBlur: () => leave(id), ...aria(id) }
          if (c.field_type === 'select') return <select {...p} value={String(val ?? '')} onChange={e => setCustom(k, e.target.value)}><option value="">Select…</option>{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          if (c.field_type === 'textarea') return <textarea {...p} rows={3} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
          if (c.field_type === 'checkbox') return <label className="row" style={{ gap: 6 }}><input id={p.id} ref={p.ref} type="checkbox" checked={!!val} onChange={e => setCustom(k, e.target.checked)} onBlur={p.onBlur} {...aria(id)} /> Yes</label>
          return <input {...p} type={c.field_type === 'phone' ? 'tel' : c.field_type} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
        } }
    }),
  ], [meta, v, customers, users, customs, errs]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = SECS.map(([s, i]) => [s, i, fields.filter(f => f.sec === s)] as const).filter(g => g[2].length)
  const miss = fields.filter(f => f.req && !f.filled)
  const pct = Math.round(fields.filter(f => f.filled).length / Math.max(fields.length, 1) * 100)
  const show = (f: F, x: V | null): string => {
    if (!x) return ''
    if (f.id.startsWith('cf_')) return String(x.custom[f.id.slice(3)] ?? '')
    const y = (x as unknown as Record<string, unknown>)[f.id]
    if (typeof y === 'boolean') return y ? 'Yes' : ''
    return y && typeof y === 'object' ? (y as Opt).name : String(y ?? '')
  }
  const changes = orig ? fields.filter(f => show(f, orig) !== show(f, v)) : []
  const jump = (id: string) => { const el = refs.current[id]; if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const reset = () => { setV(blank(meta?.me || null, validDefault(meta))); setRestored(false); setDraftNote(''); dirty.current = false; fe.clear(); setDeal(null); window.scrollTo(0, 0); setTimeout(() => refs.current.subject?.focus(), 0) }

  const save = async (again = false) => {
    const specs = Object.fromEntries(fields.map(f => [f.id, specOf(f.id, f.label, f.req)]))
    const bad = fe.validateAll(Object.fromEntries(fields.map(f => [f.id, valOf(f.id)])), specs)
    if (Object.keys(bad).length) { const first = fields.find(f => bad[f.id]); if (first) jump(first.id); return }
    const body = { subject: v.subject.trim(), customer_id: v.customer!.id, enquiry: v.enquiry.trim() || null, valid_till: v.valid || null, owner_id: v.owner?.id ?? null,
      custom_data: Object.keys(v.custom).length ? { ...v.custom } : null, ...(deal && !editId ? { deal_id: deal.id } : {}) }
    setBusy(true)
    try {
      const r = editId ? await quoteApi.update(editId, body) : await quoteApi.create(body)
      if (!editId) { dirty.current = false; try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
      success(editId ? 'Quote updated' : `Quote created → ${(r as { ref?: string }).ref || ''}`)
      if (again) reset()
      else navigate(`/quotations/${editId || r.id}`)
    } catch (e) {
      // server-side field errors (format, custom fields) land under their fields; anything else is a toast
      const fx = mapApiErrors(e, API_MAP), known = Object.fromEntries(Object.entries(fx).filter(([k]) => fields.some(f => f.id === k)))
      if (Object.keys(known).length) { fe.setErrors(x => ({ ...x, ...known })); const first = fields.find(f => known[f.id]); if (first) jump(first.id) }
      else error(errMsg(e, editId ? 'Could not save the quote' : 'Could not create the quote'))
    }
    finally { setBusy(false) }
  }
  const cancel = () => navigate(editId ? `/quotations/${editId}` : '/quotations')
  const discard = () => { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } reset(); warning('Draft discarded') }

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/quotations')}>Quotes</a></div><div className="panel"><div className="empty">{loadErr}</div></div></div>
  if (!ready || !meta) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/quotations')}>Quotes</a> / {editId ? '…' : 'New'}</div><div className="empty">Loading…</div></div>
  if (!editId && !meta.can.create) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/quotations')}>Quotes</a></div><div className="panel"><div className="empty">You do not have permission to create quotes.</div></div></div>

  return (
    <div className="bwi fpage">
      <div className="crumb"><a onClick={() => navigate('/quotations')}>Quotes</a> / {editId ? ref || '…' : 'New'}</div>
      <div className="fph">
        <div className="fpi"><Ic n="doc" size={22} /></div>
        <div className="fl"><h1>{editId ? 'Edit' : 'New'} quote</h1>
          <div className="mu">{editId ? 'Update the details below. Changes are highlighted and checked against your approval rules.' : 'Fill in the essentials – you can add more detail any time. Fields marked * are required.'}
            {restored && <> · <b>Draft restored</b> · <a onClick={discard}>Discard</a></>}</div></div>
      </div>
      <div className="fp-grid">
        <div className="fp-main">
          {deal && !editId && <div className="note inf mb"><Ic n="target" /> Linked to deal <b>{deal.name}</b> – its products become the first revision's line items.</div>}
          {groups.map(([g, icon, L]) => <section className="fsec" key={g}>
            <div className="fsh"><span className="fsi"><Ic n={icon} /></span><b>{g}</b><small className="mu">{L.length} field{L.length > 1 ? 's' : ''}</small></div>
            <div className="fg">{L.map(f => <div key={f.id} className={`${f.w === 2 ? 'f1' : ''} ${orig && changes.includes(f) ? 'chg' : ''}`}>
              <label htmlFor={`qf-${f.id}`}>{f.label}{f.req && <b> *</b>}</label>{f.node(!!errs[f.id])}<FieldError id={`qf-${f.id}`} msg={errs[f.id]} />{f.help && !errs[f.id] && <small>{f.help}</small>}</div>)}</div>
          </section>)}
        </div>
        <aside className="fp-side">
          <div className="panel"><div className="ph"><Ic n="spark" /> Summary</div><div className="pb">
            <div style={{ fontSize: 15, minHeight: 20, fontWeight: 600 }}>{v.subject.trim() || <span className="mu">Untitled</span>}</div>
            <div className="mu" style={{ fontSize: 12 }}>{v.customer?.name || v.owner?.name || ''}</div>
            <div className="mt row wrap" style={{ gap: 6 }}>{meta.stages[0] && <span className="pill wa">{meta.stages[0].name}</span>}{v.enquiry ? <span className="pill mu">{v.enquiry}</span> : null}</div>
          </div></div>
          <div className="panel mt"><div className="ph"><Ic n="check" /> Completeness</div><div className="pb">
            <div className="pm"><i style={{ width: `${pct}%`, background: miss.length ? 'var(--bw-wa)' : 'var(--bw-ok)' }} /></div>
            <div className="mt" style={{ fontSize: 12 }}>{miss.length
              ? <><span className="twarn">{miss.length} required:</span> {miss.map((f, i) => <span key={f.id}>{i ? ', ' : ''}<a onClick={() => jump(f.id)}>{f.label}</a></span>)}</>
              : <span className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> All required fields are filled</span>}{!miss.length && <> · {pct}% complete</>}</div>
          </div></div>
          {editId && changes.length > 0 && <div className="panel mt"><div className="ph"><Ic n="edit" /> {changes.length} change{changes.length > 1 ? 's' : ''}</div><div className="pb z">
            <table className="t"><tbody>{changes.map(f => <tr key={f.id}><td>{f.label}</td><td className="mu">{show(f, orig) || '—'}</td><td><b>{show(f, v) || '—'}</b></td></tr>)}</tbody></table></div></div>}
          {dups.length > 0 && <div className="note mt" style={{ borderColor: 'var(--bw-wa)' }}><Ic n="alert" /> <b>Possible duplicate</b><br />
            {dups.map(d => <div key={d.id}><a onClick={() => navigate(`/quotations/${d.id}`)}>{d.ref} – {d.subject.slice(0, 34)}</a></div>)}</div>}
          <div className="panel mt"><div className="ph"><Ic n="doc" /> Tips</div><div className="pb"><ul className="tips">{TIPS.map(t => <li key={t}>{t}</li>)}</ul></div></div>
        </aside>
      </div>
      <div className="fmbar">
        <span className="mu">{editId ? `Editing ${ref}` : draftNote ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> {draftNote}</span> : 'Draft saves automatically'}</span>
        <span className="fl" />
        <button type="button" className="btn" onClick={cancel} disabled={busy}>Cancel</button>
        {editId
          ? <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Saving…' : 'Save changes'}</button>
          : <><button type="button" className="btn" onClick={() => save(true)} disabled={busy}>Create &amp; add another</button>
            <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Creating…' : 'Create quote'}</button></>}
      </div>
    </div>
  )
}
