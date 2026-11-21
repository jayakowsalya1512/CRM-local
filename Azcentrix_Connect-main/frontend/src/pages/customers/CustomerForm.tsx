// Customer form – Bidwise prototype v17 formPage() for customers (/customers/new, /customers/:id/edit).
// Header (icon tile · New / Edit customer), sections grouped by the prototype's FSEC rules, right-hand Summary /
// Completeness / alerts / Tips, and the sticky action bar. Saves through the existing customer API, so duplicate
// checks, GST validation, approvals and audit behave exactly as before.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import api from '@/services/api'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { useAuthStore } from '@/store'
import { custApi, errMsg } from './customerApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { inferRule, mapApiErrors, type FieldSpec, type Rule } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import './c360.css'

type FType = 'text' | 'select' | 'email' | 'phone' | 'textarea' | 'number' | 'date' | 'checkbox' | 'url' | 'combo'
interface Fld { id: string; label: string; type: FType; req?: boolean; w?: number; opts?: { v: string; l: string }[]; help?: string; extra?: boolean; key?: string; disabled?: boolean }
interface FormMeta {
  customers: { id: number; name: string; level: string }[]; types: string[]; industries: string[]; groups: string[]; divisions: string[]
  states: string[]; statuses: string[]; levels: string[]; kam_modes: string[]; users: { id: number; name: string }[]
  approval: { create: { chain: string[] } | null; update: { chain: string[] } | null }; profile: { level: string; kam_mode: string } | null
}
type Vals = Record<string, string | boolean>

// prototype FSEC / fmSection(): extra (tenant) fields → Additional information, others by keyword, else Basic information
const FSEC: [string, string, RegExp | null][] = [
  ['Basic information', 'file', null],
  ['Contact & location', 'phone', /\b(contact|phone|email|city|state|address|location|pin|pincode|website|gst|pan|portal|source|mobile)\b/i],
  ['Commercials', 'card', /\b(value|amount|emd|fee|cost|price|revenue|discount|budget|tax|advance|prob|probability|tier|payment)\b/i],
  ['Ownership & timeline', 'cal', /\b(owner|kam|manager|assign|date|due|close|submit|validity|start|end|next|deadline|follow|pm|stage|priority)\b|owner|date|follow|deadline/i],
]
const FICO: Record<string, string> = { 'Basic information': 'file', 'Contact & location': 'phone', 'Commercials': 'card', 'Ownership & timeline': 'cal', 'Additional information': 'layout' }
const sectionOf = (f: Fld) => f.extra ? 'Additional information' : (FSEC.slice(1).find(([, , re]) => re!.test(`${f.id} ${f.label}`))?.[0] ?? 'Basic information')
const TIPS = ['Pick a vertical – it powers segment and vertical analytics in Customer 360.', 'Add at least one contact so the buying-centre map is useful.']
const PROTO_INDUSTRIES = ['Power', 'Rail', 'Defence', 'Water', 'Oil & Gas', 'Infrastructure']
// validation rule per built-in field (custom fields are inferred from their type / label)
const RULE: Record<string, Partial<FieldSpec>> = {
  name: { rule: 'name', min: 2, max: 255 }, gst: { rule: 'gstin' }, pan: { rule: 'pan' }, pincode: { rule: 'pincode' }, website: { rule: 'url' },
  email: { rule: 'email' }, phone: { rule: 'mobile' }, potential: { rule: 'amount' }, city: { rule: 'text', min: 2, max: 100 }, area: { rule: 'text', min: 2, max: 100 },
  country: { rule: 'text', min: 2, max: 100 }, address: { rule: 'textarea', max: 1000 }, remarks: { rule: 'textarea', max: 5000 },
  industry: { rule: 'text', max: 100 }, segment: { rule: 'text', max: 100 }, subSegment: { rule: 'text', max: 100 },
}
// API field → form field
const API_MAP: Record<string, string> = {
  customer_name: 'name', customer_vertical: 'type', billing_city: 'city', billing_state: 'state', assigned_to: 'kam', gst_number: 'gst', account_status: 'status',
  parent_account_id: 'parent', group_name: 'segment', division: 'subSegment', billing_address: 'address', billing_pincode: 'pincode', billing_area: 'area',
  billing_country: 'country', pan_number: 'pan', website: 'website', potential_value: 'potential', remarks: 'remarks', 'custom_data.email': 'email', 'custom_data.phone': 'phone', custom_data: 'cf_',
}
const TIER_OF: Record<string, string> = { High: 'A', Medium: 'B', Low: 'C' }, POT_OF: Record<string, string> = { A: 'High', B: 'Medium', C: 'Low' }
const opt = (a: string[]) => a.map(v => ({ v, l: v }))
const uniq = (a: string[]) => Array.from(new Set(a.filter(Boolean)))
const nowT = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export default function CustomerForm() {
  const { id: idParam } = useParams()
  const editId = idParam ? Number(idParam) : null
  // Row menu → Duplicate opens /customers/new?copy=<id>: a new customer pre-filled from that one.
  const [search] = useSearchParams()
  const copyId = !editId && Number(search.get('copy')) > 0 ? Number(search.get('copy')) : null
  const srcId = editId ?? copyId
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const user = useAuthStore(s => s.user)
  const tenant = useAuthStore(s => s.tenant_slug)
  const { fields: cfg } = useFormConfig('customers')
  const [meta, setMeta] = useState<FormMeta | null>(null)
  const [orig, setOrig] = useState<Vals | null>(null)
  const [origCustom, setOrigCustom] = useState<Record<string, unknown>>({})
  const [v, setV] = useState<Vals>({})
  const fe = useFieldErrors()
  const errs = fe.errors
  const [busy, setBusy] = useState(false)
  const [draftNote, setDraftNote] = useState<string>('')
  const [restored, setRestored] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const refs = useRef<Record<string, HTMLElement | null>>({})
  const dirty = useRef(false)   // the draft is only written once the user has typed something
  const draftKey = `cust-form-draft:${tenant || ''}:${user?.id || ''}`

  useEffect(() => {
    let live = true
    Promise.all([api.get<FormMeta>('/customer360/form-meta', { params: editId ? { customer_id: editId } : {} }), srcId ? api.get(`/customers/${srcId}`) : Promise.resolve(null)])
      .then(([m, c]) => {
        if (!live) return
        setMeta(m.data)
        if (c) {
          const r = c.data, cd = (r.custom_data || {}) as Record<string, unknown>
          const vals: Vals = {
            name: r.customer_name || '', type: r.customer_vertical || '', industry: r.industry || '', city: r.billing_city || '', state: r.billing_state || '',
            kam: r.assigned_to ? String(r.assigned_to) : '', tier: TIER_OF[r.account_potential] || 'B', gst: r.gst_number || '',
            email: String(cd.email ?? ''), phone: String(cd.phone ?? ''), status: r.account_status || '', parent: r.parent_account_id ? String(r.parent_account_id) : '',
            level: m.data.profile?.level || '', segment: r.group_name || '', subSegment: r.division || '', kamMode: m.data.profile?.kam_mode || 'Own KAM',
            address: r.billing_address || '', pincode: r.billing_pincode || '', area: r.billing_area || '', country: r.billing_country || '', pan: r.pan_number || '',
            website: r.website || '', potential: r.potential_value != null ? String(r.potential_value) : '', remarks: r.remarks || '',
          }
          Object.entries(cd).forEach(([k, x]) => { if (k !== 'email' && k !== 'phone') vals[`cf_${k}`] = typeof x === 'boolean' ? x : String(x ?? '') })
          if (copyId) setV({ ...vals, name: `${vals.name} (copy)`, gst: '', status: 'Prospect' })
          else { setOrig(vals); setV(vals); setOrigCustom(cd) }
        } else {
          let draft: Vals | null = null
          try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { /* private mode */ }
          if (draft && Object.values(draft).some(x => x !== '' && x !== false)) { setV(draft); setRestored(true) }
          else setV({ tier: 'B', status: 'Prospect', kamMode: 'Own KAM', kam: user?.id ? String(user.id) : '' })
        }
      })
      .catch(e => { if (live) setLoadErr(errMsg(e, 'Could not open the customer form')) })
    return () => { live = false }
  }, [editId, copyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // tenant form configuration (Form Builder): required flags of built-in fields, visible custom fields
  const cfgReq = (key: string) => cfg.some(f => !f.is_custom && f.field_key === key && f.is_required)
  const customs = cfg.filter(f => f.is_custom && f.is_visible).sort((a, b) => a.sort_order - b.sort_order)

  const fields: Fld[] = useMemo(() => {
    if (!meta) return []
    const users = meta.users.map(u => ({ v: String(u.id), l: u.name }))
    const base: Fld[] = [
      { id: 'name', label: 'Customer name', type: 'text', req: true, w: 2 },
      { id: 'type', label: 'Customer type', type: 'select', req: true, opts: opt(uniq([...meta.types, String(v.type || '')])) },
      { id: 'industry', label: 'Industry', type: 'combo', req: cfgReq('industry'), opts: opt(uniq([...PROTO_INDUSTRIES, ...meta.industries, String(v.industry || '')])) },
      { id: 'city', label: 'City', type: 'text', req: cfgReq('billing_city') },
      { id: 'state', label: 'State', type: 'select', req: cfgReq('billing_state'), opts: opt(uniq([...meta.states, String(v.state || '')])) },
      { id: 'kam', label: 'Key account manager', type: 'select', req: cfgReq('assigned_to'), opts: users },
      { id: 'tier', label: 'Tier', type: 'select', opts: opt(['A', 'B', 'C']) },
      { id: 'gst', label: 'GSTIN', type: 'text', req: cfgReq('gst_number') },
      { id: 'email', label: 'Email', type: 'email' },
      { id: 'phone', label: 'Phone', type: 'phone' },
      { id: 'status', label: 'Status', type: 'select', opts: opt(meta.statuses) },
      { id: 'parent', label: 'Parent customer', type: 'select', help: 'Leave empty for a head office / standalone customer', opts: meta.customers.map(c => ({ v: String(c.id), l: `${c.name} · ${c.level}` })) },
      { id: 'level', label: 'Hierarchy level', type: 'select', opts: opt(meta.levels) },
      { id: 'segment', label: 'Segment', type: 'combo', req: cfgReq('group_name'), opts: opt(uniq([...meta.groups, String(v.segment || '')])) },
      { id: 'subSegment', label: 'Sub-segment', type: 'combo', req: cfgReq('division'), opts: opt(uniq([...meta.divisions, String(v.subSegment || '')])) },
      { id: 'kamMode', label: 'KAM coverage', type: 'select', help: 'Common KAM = inherit; dedicated KAM = own', opts: meta.kam_modes.map(x => ({ v: x, l: x })) },
      // the application's own customer fields – tenant-specific, so the prototype files them under Additional information
      { id: 'address', label: 'Billing address', type: 'textarea', w: 2, extra: true, req: cfgReq('billing_address') },
      { id: 'pincode', label: 'Pincode', type: 'text', extra: true, req: cfgReq('billing_pincode') },
      { id: 'area', label: 'Area', type: 'text', extra: true, req: cfgReq('billing_area') },
      { id: 'country', label: 'Country', type: 'text', extra: true },
      { id: 'pan', label: 'PAN', type: 'text', extra: true, req: cfgReq('pan_number') },
      { id: 'website', label: 'Website', type: 'url', extra: true, req: cfgReq('website') },
      { id: 'potential', label: 'Potential value (₹)', type: 'number', extra: true, req: cfgReq('potential_value') },
      { id: 'remarks', label: 'Remarks', type: 'textarea', w: 2, extra: true, req: cfgReq('remarks') },
      ...customs.map((c: FormFieldConfig): Fld => ({
        id: `cf_${c.field_key}`, key: c.field_key, label: c.label, extra: true, req: c.is_required, w: c.col_span === 2 || c.field_type === 'textarea' ? 2 : 1,
        type: (c.field_type === 'select' ? 'select' : c.field_type === 'textarea' ? 'textarea' : c.field_type === 'number' ? 'number' : c.field_type === 'date' ? 'date'
          : c.field_type === 'checkbox' ? 'checkbox' : c.field_type === 'email' ? 'email' : c.field_type === 'url' ? 'url' : c.field_type === 'phone' ? 'phone' : 'text') as FType,
        opts: (c.options || []).map(o => typeof o === 'string' ? { v: o, l: o } : { v: o.value, l: o.label }),
      })),
    ]
    return base
  }, [meta, cfg, v.type, v.industry, v.state, v.segment, v.subSegment]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const g: Record<string, Fld[]> = {}
    fields.forEach(f => { (g[sectionOf(f)] ??= []).push(f) })
    return [...FSEC.map(s => s[0]), 'Additional information'].filter(n => g[n]).map(n => [n, g[n]] as [string, Fld[]])
  }, [fields])

  const filled = (x: string | boolean | undefined) => x !== undefined && x !== '' && x !== false
  const req = fields.filter(f => f.req), miss = req.filter(f => !filled(v[f.id]))
  const pct = Math.round(fields.filter(f => filled(v[f.id])).length / Math.max(fields.length, 1) * 100)
  const changes = orig ? fields.filter(f => String(orig[f.id] ?? '') !== String(v[f.id] ?? '')) : []
  const nameKey = String(v.name || '').trim().toLowerCase()
  const dups = !editId && meta && nameKey.length > 3 ? meta.customers.filter(c => { const n = c.name.toLowerCase(); return n === nameKey || (nameKey.length > 6 && n.includes(nameKey)) }).slice(0, 3) : []
  const approval = meta ? (editId ? (changes.length ? meta.approval.update : null) : meta.approval.create) : null

  // draft autosave (new customers only)
  useEffect(() => {
    if (editId || !meta || !dirty.current) return
    const t = setTimeout(() => {
      if (!Object.values(v).some(filled)) return
      try { localStorage.setItem(draftKey, JSON.stringify(v)); setDraftNote(`Draft saved ${nowT()}`) } catch { /* private mode */ }
    }, 600)
    return () => clearTimeout(t)
  }, [v, editId, meta, draftKey])

  const jump = (id: string) => { const el = refs.current[id]; if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const spec = (f: Fld): FieldSpec => ({ label: f.label, required: f.req, ...(RULE[f.id] ?? { rule: inferRule(f.key || f.id, f.label, f.type === 'combo' ? 'text' : f.type) as Rule }) })
  // cross-field / duplicate checks the generic rules cannot see
  const extra = (id: string, val: string | boolean | undefined, all: Vals): string => {
    if (id === 'name') {
      const k = String(val || '').trim().replace(/\s+/g, ' ').toLowerCase()
      const hit = k ? meta?.customers.find(c => c.id !== editId && c.name.trim().replace(/\s+/g, ' ').toLowerCase() === k) : undefined
      if (hit) return `Customer name "${hit.name}" already exists. Please use a different customer name.`
    }
    if (id === 'kamMode' && val === 'Inherit from parent' && !all.parent) return 'Choose a parent customer to inherit its KAM.'
    return ''
  }
  const check = (id: string, val: string | boolean, mode: 'change' | 'blur', all: Vals = v) => {
    const f = fields.find(x => x.id === id); if (!f) return
    if (mode === 'change') fe.change(id, val, spec(f)); else fe.blur(id, val, spec(f))
    const x = extra(id, val, all); if (x) fe.setError(id, x)
  }
  const set = (id: string, x: string | boolean) => {
    dirty.current = true
    const next = { ...v, [id]: x }
    setV(s => ({ ...s, [id]: x })); check(id, x, 'change', next)
    if (id === 'parent' && errs.kamMode) check('kamMode', next.kamMode ?? '', 'blur', next)
  }
  const leave = (id: string) => check(id, v[id] ?? '', 'blur')

  const save = async (again = false) => {
    const specs = Object.fromEntries(fields.map(f => [f.id, spec(f)]))
    const ex = Object.fromEntries(fields.map(f => [f.id, extra(f.id, v[f.id], v)]).filter(([, m]) => m))
    const bad = fe.validateAll(v, specs, ex)
    if (Object.keys(bad).length) { const first = fields.find(f => bad[f.id]); if (first) jump(first.id); return }
    const custom: Record<string, unknown> = { ...origCustom }
    if (String(v.email || '').trim()) custom.email = String(v.email).trim(); else delete custom.email
    if (String(v.phone || '').trim()) custom.phone = String(v.phone).trim(); else delete custom.phone
    fields.filter(f => f.key).forEach(f => { custom[f.key!] = v[f.id] ?? (f.type === 'checkbox' ? false : '') })
    const s = (k: string) => String(v[k] ?? '').trim() || null
    const payload: Record<string, unknown> = {
      customer_name: String(v.name).trim(), customer_vertical: s('type'), industry: s('industry'), billing_city: s('city'), billing_state: s('state'),
      assigned_to: v.kam ? Number(v.kam) : null, account_potential: POT_OF[String(v.tier || 'B')] || 'Medium', gst_number: s('gst')?.toUpperCase() ?? null,
      account_status: s('status') || 'Prospect', parent_account_id: v.parent ? Number(v.parent) : null, group_name: s('segment'), division: s('subSegment'),
      billing_address: s('address'), billing_pincode: s('pincode'), billing_area: s('area'), billing_country: s('country'), pan_number: s('pan')?.toUpperCase() ?? null,
      website: s('website'), potential_value: v.potential ? Number(v.potential) : null, remarks: s('remarks'), custom_data: Object.keys(custom).length ? custom : null,
    }
    setBusy(true)
    try {
      const r = editId ? await api.put(`/customers/${editId}`, payload) : await api.post('/customers/', payload)
      const id = editId || r.data.id
      const hier: Record<string, string> = {}
      if (v.level && (!orig || orig.level !== v.level)) hier.level = String(v.level)
      if (v.kamMode && (!orig || orig.kamMode !== v.kamMode)) hier.kam_mode = String(v.kamMode)
      if (Object.keys(hier).length) {
        try { await custApi.setHierarchy(id, hier) } catch (e) { warning('Customer saved', errMsg(e, 'Hierarchy settings could not be saved')) }
      }
      if (!editId) { dirty.current = false; try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
      const pending = (r.data?.approval_status || '') === 'pending'
      success(editId ? 'Customer updated' : `Customer created${pending ? ' – waiting for approval' : ''}`)
      if (again) { setV({ tier: 'B', status: 'Prospect', kamMode: 'Own KAM', kam: user?.id ? String(user.id) : '' }); fe.clear(); setRestored(false); setDraftNote(''); window.scrollTo(0, 0); refs.current.name?.focus() }
      else navigate(`/customers/${id}`)
    } catch (e) {
      // server-side field errors (format, duplicates, custom fields) land under their fields; anything else is a toast
      const fx = mapApiErrors(e, API_MAP), known = Object.fromEntries(Object.entries(fx).filter(([k]) => fields.some(f => f.id === k)))
      if (Object.keys(known).length) { fe.setErrors(x => ({ ...x, ...known })); const first = fields.find(f => known[f.id]); if (first) jump(first.id) }
      else error(errMsg(e, editId ? 'Could not save the customer' : 'Could not create the customer'))
    }
    finally { setBusy(false) }
  }
  const cancel = () => navigate(editId ? `/customers/${editId}` : '/customers')

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/customers')}>Customers</a></div><div className="panel"><div className="empty">{loadErr}</div></div></div>
  if (!meta) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/customers')}>Customers</a> / {editId ? '…' : 'New'}</div><div className="empty">Loading…</div></div>

  const input = (f: Fld): ReactNode => {
    const val = v[f.id], cls = `in ${errs[f.id] ? 'err' : ''}`
    const common = { id: `cf-${f.id}`, 'data-f': f.id, ref: (el: HTMLElement | null) => { refs.current[f.id] = el }, onBlur: () => leave(f.id),
      'aria-invalid': errs[f.id] ? true : undefined, 'aria-describedby': errs[f.id] ? `cf-${f.id}-err` : undefined }
    if (f.type === 'select') return <select {...common} className={cls} value={String(val ?? '')} onChange={e => set(f.id, e.target.value)}>
      <option value="">{f.id === 'parent' ? '— none (top level) —' : 'Select…'}</option>
      {f.opts!.map(o => <option key={o.v} value={o.v} disabled={f.id === 'kamMode' && o.v === 'Inherit from parent' && !v.parent}>{o.l}</option>)}</select>
    if (f.type === 'combo') return <><input {...common} className={cls} list={`dl-${f.id}`} placeholder="Select…" value={String(val ?? '')} onChange={e => set(f.id, e.target.value)} />
      <datalist id={`dl-${f.id}`}>{f.opts!.map(o => <option key={o.v} value={o.v} />)}</datalist></>
    if (f.type === 'textarea') return <textarea {...common} className={cls} rows={3} value={String(val ?? '')} onChange={e => set(f.id, e.target.value)} />
    if (f.type === 'checkbox') return <label className="row" style={{ gap: 6 }}><input {...common} type="checkbox" checked={!!val} onChange={e => set(f.id, e.target.checked)} /> Yes</label>
    return <input {...common} className={cls} type={f.type === 'phone' ? 'tel' : f.type} value={String(val ?? '')} onChange={e => set(f.id, e.target.value)} />
  }
  const title = String(v.name || '').trim()
  const kamName = meta.users.find(u => String(u.id) === String(v.kam))?.name

  return (
    <div className="bwi fpage">
      <div className="crumb"><a onClick={() => navigate('/customers')}>Customers</a> / {editId ? (String(orig?.name || '').slice(0, 40) || '…') : 'New'}</div>
      <div className="fph">
        <div className="fpi"><Ic n="building" size={22} /></div>
        <div className="fl"><h1>{editId ? 'Edit' : 'New'} customer</h1>
          <div className="mu">{editId ? 'Update the details below. Changes are highlighted and checked against your approval rules.' : 'Fill in the essentials – you can add more detail any time. Fields marked * are required.'}{restored && <> · <b>Draft restored</b></>}</div></div>
      </div>
      <div className="fp-grid">
        <div className="fp-main">
          {groups.map(([g, L]) => <section className="fsec" key={g}>
            <div className="fsh"><span className="fsi"><Ic n={FICO[g]} /></span><b>{g}</b><small className="mu">{L.length} field{L.length > 1 ? 's' : ''}</small></div>
            <div className="fg">{L.map(f => <div key={f.id} className={`${(f.w || 1) > 1 || f.type === 'textarea' ? 'f1' : ''} ${orig && changes.includes(f) ? 'chg' : ''}`}>
              <label htmlFor={`cf-${f.id}`}>{f.label}{f.req && <b> *</b>}</label>{input(f)}<FieldError id={`cf-${f.id}`} msg={errs[f.id]} />{f.help && !errs[f.id] && <small>{f.help}</small>}</div>)}</div>
          </section>)}
        </div>
        <aside className="fp-side">
          <div className="panel"><div className="ph"><Ic n="spark" /> Summary</div><div className="pb">
            <div className="b" style={{ fontSize: 15, minHeight: 20 }}>{title || <span className="mu">Untitled</span>}</div>
            <div className="mu" style={{ fontSize: 12 }}>{kamName || ''}</div>
            <div className="mt">{v.type ? <span className="pill ac">{String(v.type)}</span> : null}</div>
          </div></div>
          <div className="panel mt"><div className="ph"><Ic n="check" /> Completeness</div><div className="pb">
            <div className="pm"><i style={{ width: `${pct}%`, background: miss.length ? 'var(--bw-wa)' : 'var(--bw-ok)' }} /></div>
            <div className="mt" style={{ fontSize: 12 }}>{miss.length
              ? <><span className="twarn">{miss.length} required:</span> {miss.map((f, i) => <span key={f.id}>{i ? ', ' : ''}<a onClick={() => jump(f.id)}>{f.label}</a></span>)}</>
              : <span className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> All required fields are filled</span>}{!miss.length && <> · {pct}% complete</>}</div>
          </div></div>
          {editId && changes.length > 0 && <div className="panel mt"><div className="ph"><Ic n="edit" /> {changes.length} change{changes.length > 1 ? 's' : ''}</div><div className="pb z">
            <table className="t"><tbody>{changes.map(f => { const show = (x: string | boolean | undefined) => f.type === 'select' ? (f.opts!.find(o => o.v === String(x))?.l || String(x || '') || '—') : (String(x ?? '') || '—')
              return <tr key={f.id}><td>{f.label}</td><td className="mu">{show(orig![f.id])}</td><td><b>{show(v[f.id])}</b></td></tr> })}</tbody></table></div></div>}
          {approval && <div className="note mt"><Ic n="lock" /> <b>Approval needed.</b> {editId ? 'These changes will be held until' : 'After creating, this record waits for'} {approval.chain.join(' › ') || 'the configured approvers'}{editId ? ' approve.' : '.'}</div>}
          {dups.length > 0 && <div className="note mt" style={{ borderColor: 'var(--bw-wa)' }}><Ic n="alert" /> <b>Possible duplicate</b><br />
            {dups.map(d => <div key={d.id}><a onClick={() => navigate(`/customers/${d.id}`)}>CUS-{String(d.id).padStart(4, '0')} – {d.name.slice(0, 34)}</a></div>)}</div>}
          <div className="panel mt"><div className="ph"><Ic n="spark" /> Tips</div><div className="pb"><ul className="tips">{TIPS.map(t => <li key={t}>{t}</li>)}</ul></div></div>
        </aside>
      </div>
      <div className="fmbar">
        <span className="mu">{editId ? `Editing CUS-${String(editId).padStart(4, '0')}` : draftNote ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> {draftNote}</span> : 'Draft saves automatically'}</span>
        <span className="fl" />
        <button type="button" className="btn" onClick={cancel} disabled={busy}>Cancel</button>
        {editId
          ? <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Saving…' : 'Save changes'}</button>
          : <><button type="button" className="btn" onClick={() => save(true)} disabled={busy}>Create &amp; add another</button>
            <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Creating…' : 'Create customer'}</button></>}
      </div>
    </div>
  )
}
