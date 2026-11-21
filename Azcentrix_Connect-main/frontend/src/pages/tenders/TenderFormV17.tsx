// Bid form – prototype v17 formPage('tenders') (/tenders/new, /tenders/:id/form). Header tile · sections
// Basic information (Tender title, Tender / NIT number, Customer, Category, Business vertical, Sales flow) / Contact & location (Portal, Location) /
// Commercials (Estimated value, EMD amount) / Ownership & timeline (Bid submission date, Bid manager) / Additional
// information (Form Builder fields); side panels Summary / Completeness / approval & duplicate notes / Tips; sticky
// Cancel · Create & add another · Create bid (Save changes when editing). Every option comes from a Masters API.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { useAuthStore } from '@/store'
import Lookup from '@/pages/leads/Lookup'
import { masters, useMaster } from '@/pages/leads/leadApi'
import { bidApi, errMsg, inr, type Meta, type Opt } from './bidApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { inferRule, mapApiErrors, type FieldSpec, type Val } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './tenders.css'

type Sec = 'Basic information' | 'Contact & location' | 'Commercials' | 'Ownership & timeline' | 'Additional information'
const SECS: [Sec, string][] = [['Basic information', 'file'], ['Contact & location', 'users'], ['Commercials', 'card'], ['Ownership & timeline', 'cal'], ['Additional information', 'layout']]
const nowT = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

interface V { title: string; nit: string; customer: Opt | null; portal: Opt | null; value: string; emd: string; submit: string; owner: Opt | null; category: Opt | null; location: Opt | null; vertical: Opt | null; flow: string; custom: Record<string, string | boolean> }
// validation rule per built-in field (backend BidIn); custom fields are inferred from their type / label
const RULE: Record<string, Partial<FieldSpec>> = {
  title: { rule: 'text', min: 3, max: 500 }, nit: { rule: 'text', min: 2, max: 200 }, customer: { rule: 'select' }, portal: { rule: 'select' },
  value: { rule: 'amount' }, emd: { rule: 'amount' }, submit: { rule: 'date' }, owner: { rule: 'select' }, category: { rule: 'select' },
  location: { rule: 'select' }, vertical: { rule: 'select' }, flow: { rule: 'select' },
}
// API field → form field
const API_MAP: Record<string, string> = {
  customer_id: 'customer', portal_id: 'portal', owner_id: 'owner', category_id: 'category', location_id: 'location', vertical_id: 'vertical', custom_data: 'cf_',
}
const blank = (owner: Opt | null): V => ({ title: '', nit: '', customer: null, portal: null, value: '', emd: '', submit: '', owner, category: null, location: null, vertical: null, flow: '', custom: {} })

export default function TenderFormV17() {
  const { id: idParam } = useParams()
  const editId = idParam ? Number(idParam) : null
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const user = useAuthStore(s => s.user)
  const tenant = useAuthStore(s => s.tenant_slug)
  const { fields: cfg } = useFormConfig('tenders')
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
  const [dups, setDups] = useState<{ id: number; ref: string; title: string; why: string }[]>([])
  const refs = useRef<Record<string, HTMLElement | null>>({})
  const dirty = useRef(false)
  const draftKey = `tender-form-draft:${tenant || ''}:${user?.id || ''}`

  const [custQ, setCustQ] = useState('')
  const [locQ, setLocQ] = useState('')
  const customers = useMaster(() => bidApi.customers(custQ), [custQ])
  const locations = useMaster(() => bidApi.locations(locQ), [locQ])
  const mst = useMaster(() => bidApi.masters().then(m => [...m.portals.map(x => ({ ...x, sub: 'portal' })), ...m.categories.map(x => ({ ...x, sub: 'category' })),
    ...m.verticals.map(x => ({ id: x.id, name: x.name, sub: 'vertical' }))]))
  const portals = useMemo(() => mst.items ? mst.items.filter(x => x.sub === 'portal').map(x => ({ id: x.id, name: x.name })) : null, [mst.items])
  const categories = useMemo(() => mst.items ? mst.items.filter(x => x.sub === 'category').map(x => ({ id: x.id, name: x.name })) : null, [mst.items])
  const verticals = useMemo(() => mst.items ? mst.items.filter(x => x.sub === 'vertical').map(x => ({ id: x.id, name: x.name })) : null, [mst.items])
  const users = useMaster(masters.users)

  useEffect(() => {
    bidApi.meta().then(m => { setMeta(m); if (!editId) setV(s => dirty.current || restored ? s : { ...s, owner: s.owner || m.me }) })
      .catch(e => setLoadErr(errMsg(e, 'Could not open the tender form')))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const fromDetail = (id: number, copy: boolean) => bidApi.get(id).then(d => {
    const b = d.basic
    const val: V = { title: copy ? `${b.title} (copy)` : b.title, nit: copy ? '' : b.nit, customer: b.customer, portal: b.portal, value: b.value ? String(b.value) : '',
      emd: b.emd ? String(b.emd) : '', submit: copy ? '' : d.details.submit || '', owner: b.owner, category: b.category, location: b.location, vertical: b.vertical, flow: d.flow.key,
      custom: Object.fromEntries(Object.entries(b.custom_data || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')])) }
    return { val, ref: d.ref }
  })
  useEffect(() => {
    let live = true
    if (editId) {
      fromDetail(editId, false).then(({ val, ref: r }) => { if (live) { setV(val); setOrig(val); setRef(r); setReady(true) } }).catch(e => { if (live) setLoadErr(errMsg(e, 'Could not open this tender')) })
      return () => { live = false }
    }
    const copyId = Number(sp.get('copy')) || null       // row menu → Duplicate
    if (copyId) {
      fromDetail(copyId, true).then(({ val }) => { if (live) { dirty.current = true; setV(s => ({ ...val, owner: val.owner || s.owner })) } }).catch(e => { if (live) error(errMsg(e, 'Could not copy that tender')) })
      return () => { live = false }
    }
    const cust = Number(sp.get('customer')) || null      // "New bid" from Customer 360
    let draft: V | null = null
    try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { /* private mode */ }
    if (!cust && draft && (draft.title || draft.nit || draft.customer)) { setV(s => ({ ...s, ...draft })); setRestored(true) }
    if (cust) bidApi.customers('').then(L => { const c = L.find(x => x.id === cust); if (c && live) setV(s => ({ ...s, customer: c })) }).catch(() => { /* lookup still works */ })
    return () => { live = false }
  }, [editId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!v.nit.trim() && !(v.customer && v.title.trim())) { setDups([]); return }
    const t = setTimeout(() => { bidApi.duplicates({ customer_id: v.customer?.id, title: v.title, nit: v.nit, exclude_id: editId ?? undefined }).then(setDups).catch(() => setDups([])) }, 300)
    return () => clearTimeout(t)
  }, [v.customer?.id, v.title, v.nit, editId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editId || !dirty.current) return
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify(v)); setDraftNote(`Draft saved ${nowT()}`) } catch { /* private mode */ } }, 600)
    return () => clearTimeout(t)
  }, [v, editId, draftKey])

  const customs = cfg.filter(f => f.is_custom && f.is_visible).sort((a, b) => a.sort_order - b.sort_order)
  const cfgReq = (k: string) => cfg.some(f => !f.is_custom && f.field_key === k && f.is_required && f.is_visible)
  // validation: built-in fields use RULE + their required flag, Form Builder fields are inferred from key / label / type
  const specOf = (id: string, label: string, req: boolean): FieldSpec | undefined => {
    if (id.startsWith('cf_')) {
      const c = customs.find(x => `cf_${x.field_key}` === id); if (!c) return undefined
      return { label: c.label, required: c.is_required, rule: inferRule(c.field_key, c.label, c.field_type) }
    }
    return RULE[id] ? { label, required: req, ...RULE[id] } : undefined
  }
  const valOf = (id: string, x: V = v): Val => id.startsWith('cf_') ? x.custom[id.slice(3)] : (x as unknown as Record<string, Val>)[id]
  // cross-field checks the generic rules cannot see
  const extra = (id: string, x: V): string => {
    if (id === 'emd' && x.emd !== '' && x.value !== '' && Number.isFinite(Number(x.emd)) && Number.isFinite(Number(x.value)) && Number(x.emd) > Number(x.value))
      return 'EMD cannot be more than the tender value.'
    return ''
  }
  const check = (id: string, mode: 'change' | 'blur', x: V = v) => {
    const f = fields.find(y => y.id === id); if (!f) return   // `fields` is declared below; handlers only run after render
    const sp = specOf(id, f.label, f.req); if (!sp) return
    if (mode === 'change') fe.change(id, valOf(id, x), sp); else fe.blur(id, valOf(id, x), sp)
    const m = extra(id, x); if (m) fe.setError(id, m)
  }
  const leave = (id: string) => check(id, 'blur')
  const set = <K extends keyof V>(k: K, x: V[K]) => {
    dirty.current = true; const next = { ...v, [k]: x }; setV(s => ({ ...s, [k]: x }))
    // picking from a lookup / dropdown counts as leaving the field
    check(k as string, typeof x === 'object' || k === 'flow' ? 'blur' : 'change', next)
    if (k === 'value' && (errs.emd || next.emd)) check('emd', 'change', next)
  }
  const setCustom = (k: string, x: string | boolean) => { dirty.current = true; const next = { ...v, custom: { ...v.custom, [k]: x } }; setV(s => ({ ...s, custom: { ...s.custom, [k]: x } })); check(`cf_${k}`, 'change', next) }
  const aria = (id: string) => ({ 'aria-invalid': errs[id] ? true : undefined, 'aria-describedby': errs[id] ? `tf-${id}-err` : undefined })
  const emdPct = meta?.config.emd_default_pct ?? 0

  type F = { id: string; label: string; sec: Sec; req: boolean; w?: 2; help?: string; filled: boolean; node: (bad: boolean) => ReactNode }
  const lk = (id: keyof V, label: string, items: { items: Opt[] | null; error?: string; reload?: () => void }, empty: string, extra: Partial<Parameters<typeof Lookup>[0]> = {}) =>
    (bad: boolean) => <Lookup id={`tf-${id}`} value={(v[id] as Opt | null)?.id ?? null} label={(v[id] as Opt | null)?.name} items={items.items} error={items.error} onRetry={items.reload}
      bad={bad} emptyText={empty} inputRef={el => { refs.current[id] = el }} onChange={o => set(id, o as never)} placeholder={`Select ${label.toLowerCase()}…`} {...extra} />
  const fields: F[] = useMemo(() => !meta ? [] : [
    { id: 'title', label: 'Tender title', sec: 'Basic information', req: true, w: 2, filled: !!v.title.trim(),
      node: bad => <input id="tf-title" ref={el => { refs.current.title = el }} className={`in ${bad ? 'err' : ''}`} maxLength={500} value={v.title} onChange={e => set('title', e.target.value)} onBlur={() => leave('title')} {...aria('title')} /> },
    { id: 'nit', label: 'Tender / NIT number', sec: 'Basic information', req: true, filled: !!v.nit.trim(),
      node: bad => <input id="tf-nit" ref={el => { refs.current.nit = el }} className={`in ${bad ? 'err' : ''}`} maxLength={200} value={v.nit} onChange={e => set('nit', e.target.value)} onBlur={() => leave('nit')} {...aria('nit')} /> },
    { id: 'customer', label: 'Customer', sec: 'Basic information', req: true, filled: !!v.customer,
      node: lk('customer', 'Customer', customers, 'No customers you can work with', { onSearch: setCustQ, clearable: false }) },
    { id: 'portal', label: 'Portal', sec: 'Contact & location', req: cfgReq('source_id'), filled: !!v.portal,
      node: lk('portal', 'Portal', { items: portals, error: mst.error, reload: mst.reload }, 'No active portals in Masters') },
    { id: 'value', label: 'Estimated value', sec: 'Commercials', req: cfgReq('est_value'), filled: !!v.value,
      node: bad => <div className="cur-in"><span>₹</span><input id="tf-value" ref={el => { refs.current.value = el }} className={`in ${bad ? 'err' : ''}`} type="number" min={0} step="any" inputMode="decimal"
        value={v.value} onChange={e => set('value', e.target.value)} onBlur={() => leave('value')} {...aria('value')} /></div> },
    { id: 'emd', label: 'EMD amount', sec: 'Commercials', req: false, filled: !!v.emd, help: v.value && !v.emd && emdPct ? `Defaults to ${emdPct}% of value – ${inr(Number(v.value) * emdPct / 100)}` : undefined,
      node: bad => <div className="cur-in"><span>₹</span><input id="tf-emd" ref={el => { refs.current.emd = el }} className={`in ${bad ? 'err' : ''}`} type="number" min={0} step="any" inputMode="decimal"
        value={v.emd} onChange={e => set('emd', e.target.value)} onBlur={() => leave('emd')} {...aria('emd')} /></div> },
    { id: 'submit', label: 'Bid submission date', sec: 'Ownership & timeline', req: true, filled: !!v.submit,
      node: bad => <input id="tf-submit" ref={el => { refs.current.submit = el }} className={`in ${bad ? 'err' : ''}`} type="date" value={v.submit} onChange={e => set('submit', e.target.value)} onBlur={() => leave('submit')} {...aria('submit')} /> },
    { id: 'owner', label: 'Bid manager', sec: 'Ownership & timeline', req: cfgReq('assigned_to'), filled: !!v.owner,
      node: lk('owner', 'Bid manager', users, 'No active users') },
    { id: 'category', label: 'Category', sec: 'Basic information', req: false, filled: !!v.category,
      node: lk('category', 'Category', { items: categories, error: mst.error, reload: mst.reload }, 'No active categories in Masters') },
    { id: 'location', label: 'Location', sec: 'Contact & location', req: false, filled: !!v.location,
      node: lk('location', 'Location', locations, 'No matching location in Masters', { onSearch: setLocQ }) },
    { id: 'vertical', label: 'Business vertical', sec: 'Basic information', req: false, filled: !!v.vertical,
      node: lk('vertical', 'Business vertical', { items: verticals, error: mst.error, reload: mst.reload }, 'No business verticals in Masters') },
    { id: 'flow', label: 'Sales flow', sec: 'Basic information', req: false, filled: !!v.flow, help: 'Each company can run several flows – choose the one this record follows',
      node: bad => <select id="tf-flow" ref={el => { refs.current.flow = el }} className={`in ${bad ? 'err' : ''}`} value={v.flow} onChange={e => set('flow', e.target.value)} onBlur={() => leave('flow')} {...aria('flow')}>
        <option value="">Automatic (by business model / type)</option>
        {meta.flows.filter(f => f.active || f.key === v.flow).map(f => <option key={f.key} value={f.key}>{f.name}</option>)}</select> },
    ...customs.map((c: FormFieldConfig): F => {
      const k = c.field_key, val = v.custom[k], id = `cf_${k}`
      const opts = (c.options || []).map(o => typeof o === 'string' ? { v: o, l: o } : { v: o.value, l: o.label })
      return { id, label: c.label, sec: 'Additional information', req: c.is_required, w: c.col_span === 2 || c.field_type === 'textarea' ? 2 : undefined,
        filled: val !== undefined && val !== '' && val !== false,
        node: bad => {
          const p = { id: `tf-${id}`, ref: (el: HTMLElement | null) => { refs.current[id] = el }, className: `in ${bad ? 'err' : ''}`, onBlur: () => leave(id), ...aria(id) }
          if (c.field_type === 'select') return <select {...p} value={String(val ?? '')} onChange={e => setCustom(k, e.target.value)}><option value="">Select…</option>{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          if (c.field_type === 'textarea') return <textarea {...p} rows={3} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
          if (c.field_type === 'checkbox') return <label className="row" style={{ gap: 6 }}><input id={p.id} ref={p.ref} type="checkbox" checked={!!val} onChange={e => setCustom(k, e.target.checked)} onBlur={p.onBlur} {...aria(id)} /> Yes</label>
          return <input {...p} type={c.field_type === 'phone' ? 'tel' : c.field_type} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
        } }
    }),
  ], [meta, v, customers, locations, portals, categories, verticals, mst, users, customs, errs, emdPct]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = SECS.map(([s, i]) => [s, i, fields.filter(f => f.sec === s)] as const).filter(g => g[2].length)
  const miss = fields.filter(f => f.req && !f.filled)
  const pct = Math.round(fields.filter(f => f.filled).length / Math.max(fields.length, 1) * 100)
  const gated = (meta?.stages || []).filter(s => s.gate === 'Approval').map(s => s.name)
  const show = (f: F, x: V | null): string => {
    if (!x) return ''
    if (f.id.startsWith('cf_')) return String(x.custom[f.id.slice(3)] ?? '')
    const y = (x as unknown as Record<string, unknown>)[f.id]
    if (f.id === 'flow') return meta?.flows.find(x => x.key === y)?.name || (y ? String(y) : 'Automatic')
    if (typeof y === 'boolean') return y ? 'Yes' : ''
    return y && typeof y === 'object' ? (y as Opt).name : String(y ?? '')
  }
  const changes = orig ? fields.filter(f => show(f, orig) !== show(f, v)) : []
  const jump = (id: string) => { const el = refs.current[id]; if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const reset = () => { setV(blank(meta?.me || null)); setRestored(false); setDraftNote(''); dirty.current = false; fe.clear(); window.scrollTo(0, 0); setTimeout(() => refs.current.title?.focus(), 0) }

  const save = async (again = false) => {
    const specs = Object.fromEntries(fields.map(f => [f.id, specOf(f.id, f.label, f.req)]))
    const vals = Object.fromEntries(fields.map(f => [f.id, valOf(f.id)]))
    const ex = Object.fromEntries(fields.map(f => [f.id, extra(f.id, v)]).filter(([, m]) => m))
    const bad = fe.validateAll(vals, specs, ex)
    if (Object.keys(bad).length) { const first = fields.find(f => bad[f.id]); if (first) jump(first.id); return }
    const body = {
      title: v.title.trim(), nit: v.nit.trim(), customer_id: v.customer!.id, portal_id: v.portal?.id ?? null, value: v.value ? Number(v.value) : null, emd: v.emd ? Number(v.emd) : null,
      submit: v.submit, owner_id: v.owner?.id ?? null, category_id: v.category?.id ?? null, location_id: v.location?.id ?? null,
      vertical_id: v.vertical?.id ?? null, flow: v.flow || null,
      custom_data: Object.keys(v.custom).length ? { ...v.custom } : null,
    }
    setBusy(true)
    try {
      const r = editId ? await bidApi.update(editId, body) : await bidApi.create(body)
      if (!editId) { dirty.current = false; try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
      success(editId ? 'Tender updated' : `Tender created → ${(r as { ref?: string }).ref || ''}`)
      if (again) reset()
      else navigate(`/tenders/${editId || r.id}`)
    } catch (e) {
      // server-side field errors (format, duplicate NIT → 409, EMD > value, custom fields) land under their fields; anything else is a toast
      const fx = mapApiErrors(e, API_MAP), known = Object.fromEntries(Object.entries(fx).filter(([k]) => fields.some(f => f.id === k)))
      if (Object.keys(known).length) { fe.setErrors(x => ({ ...x, ...known })); const first = fields.find(f => known[f.id]); if (first) jump(first.id) }
      else error(errMsg(e, editId ? 'Could not save the tender' : 'Could not create the tender'))
    }
    finally { setBusy(false) }
  }
  const cancel = () => navigate(editId ? `/tenders/${editId}` : '/tenders')
  const discard = () => { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } reset(); warning('Draft discarded') }

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/tenders')}>Bids &amp; Tenders</a></div><div className="panel"><div className="empty">{loadErr}</div></div></div>
  if (!ready || !meta) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/tenders')}>Bids &amp; Tenders</a> / {editId ? '…' : 'New'}</div><div className="empty">Loading…</div></div>
  if (!editId && !meta.can.create) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/tenders')}>Bids &amp; Tenders</a></div><div className="panel"><div className="empty">You do not have permission to create tenders.</div></div></div>
  if (editId && !meta.can.update) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/tenders')}>Bids &amp; Tenders</a></div><div className="panel"><div className="empty">You do not have permission to edit tenders.</div></div></div>

  return (
    <div className="bwi fpage">
      <div className="crumb"><a onClick={() => navigate('/tenders')}>Bids &amp; Tenders</a> / {editId ? (orig?.title || ref).slice(0, 40) : 'New'}</div>
      <div className="fph">
        <div className="fpi"><Ic n="file" size={22} /></div>
        <div className="fl"><h1>{editId ? 'Edit' : 'New'} bid</h1>
          <div className="mu">{editId ? 'Update the details below. Changes are highlighted and checked against your approval rules.' : 'Fill in the essentials – you can add more detail any time. Fields marked * are required.'}
            {restored && <> · <b>Draft restored</b> · <a onClick={discard}>Discard</a></>}</div></div>
      </div>
      <div className="fp-grid">
        <div className="fp-main">
          {groups.map(([g, icon, L]) => <section className="fsec" key={g}>
            <div className="fsh"><span className="fsi"><Ic n={icon} /></span><b>{g}</b><small className="mu">{L.length} field{L.length > 1 ? 's' : ''}</small></div>
            <div className="fg">{L.map(f => <div key={f.id} className={`${f.w === 2 ? 'f1' : ''} ${orig && changes.includes(f) ? 'chg' : ''}`}>
              <label htmlFor={`tf-${f.id}`}>{f.label}{f.req && <b> *</b>}</label>{f.node(!!errs[f.id])}<FieldError id={`tf-${f.id}`} msg={errs[f.id]} />{f.help && !errs[f.id] && <small>{f.help}</small>}</div>)}</div>
          </section>)}
        </div>
        <aside className="fp-side">
          <div className="panel"><div className="ph"><Ic n="spark" /> Summary</div><div className="pb">
            <div style={{ fontSize: 15, minHeight: 20, fontWeight: 600 }}>{v.title.trim() || <span className="mu">Untitled</span>}</div>
            <div className="mu" style={{ fontSize: 12 }}>{v.customer?.name || v.owner?.name || ''}</div>
            {v.value ? <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>{inr(Number(v.value))}</div> : null}
            <div className="mt row wrap" style={{ gap: 6 }}>{v.portal ? <span className="pill mu">{v.portal.name}</span> : null}{v.category ? <span className="pill ac">{v.category.name}</span> : null}</div>
          </div></div>
          <div className="panel mt"><div className="ph"><Ic n="check" /> Completeness</div><div className="pb">
            <div className="pm"><i style={{ width: `${pct}%`, background: miss.length ? 'var(--bw-wa)' : 'var(--bw-ok)' }} /></div>
            <div className="mt" style={{ fontSize: 12 }}>{miss.length
              ? <><span className="twarn">{miss.length} required:</span> {miss.map((f, i) => <span key={f.id}>{i ? ', ' : ''}<a onClick={() => jump(f.id)}>{f.label}</a></span>)}</>
              : <span className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> All required fields are filled</span>}{!miss.length && <> · {pct}% complete</>}</div>
          </div></div>
          {editId && changes.length > 0 && <div className="panel mt"><div className="ph"><Ic n="edit" /> {changes.length} change{changes.length > 1 ? 's' : ''}</div><div className="pb z">
            <table className="t"><tbody>{changes.map(f => <tr key={f.id}><td>{f.label}</td><td className="mu">{show(f, orig) || '—'}</td><td><b>{show(f, v) || '—'}</b></td></tr>)}</tbody></table></div></div>}
          {gated.length > 0 && <div className="note mt"><Ic n="lock" /> <b>Approval needed</b> to move into {gated.join(', ')} – configured in Approvals.</div>}
          {dups.length > 0 && <div className="note mt" style={{ borderColor: 'var(--bw-wa)' }}><Ic n="alert" /> <b>Possible duplicate</b><br />
            {dups.map(d => <div key={d.id}><a onClick={() => navigate(`/tenders/${d.id}`)}>{d.ref} – {d.title.slice(0, 34)}</a> <small className="mu">· {d.why}</small></div>)}</div>}
          <div className="panel mt"><div className="ph"><Ic n="note" /> Tips</div><div className="pb"><ul className="tips">
            <li>Enter the NIT / tender number exactly as on the portal.</li>
            <li>EMD defaults to {emdPct}% of value if left empty.</li>
            <li>Deadline drives alerts at {(meta.config.reminder_days || []).join(', ') || '—'} day{(meta.config.reminder_days || []).length === 1 ? '' : 's'}.</li>
          </ul></div></div>
        </aside>
      </div>
      <div className="fmbar">
        <span className="mu">{editId ? `Editing ${ref}` : draftNote ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Ic n="check" size={13} /> {draftNote}</span> : 'Draft saves automatically'}</span>
        <span className="fl" />
        <button type="button" className="btn" onClick={cancel} disabled={busy}>Cancel</button>
        {editId
          ? <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Saving…' : 'Save changes'}</button>
          : <><button type="button" className="btn" onClick={() => save(true)} disabled={busy}>Create &amp; add another</button>
            <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Creating…' : 'Create bid'}</button></>}
      </div>
    </div>
  )
}
