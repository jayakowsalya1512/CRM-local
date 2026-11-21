// Deal form – prototype v17 formPage('opps') (/opportunities/new, /opportunities/:id/edit). Header tile · sections
// Basic information (Opportunity name, Customer, Workflow type) / Contact & location (Source) / Commercials (Value,
// EMD required) / Ownership & timeline (Expected close, Owner) / Additional information (Form Builder fields), side
// panels Summary / Completeness / approval & duplicate notes / Tips, sticky Cancel · Create & add another · Create deal.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { useAuthStore } from '@/store'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { inferRule, mapApiErrors, todayISO, type FieldSpec, type Val } from '@/utils/validation'
import Lookup from '@/pages/leads/Lookup'
import { masters, useMaster, type Opt } from '@/pages/leads/leadApi'
import { dealApi, errMsg, inr, type Meta } from './dealApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './deals.css'

type Sec = 'Basic information' | 'Contact & location' | 'Commercials' | 'Ownership & timeline' | 'Additional information'
const SECS: [Sec, string][] = [['Basic information', 'file'], ['Contact & location', 'users'], ['Commercials', 'card'], ['Ownership & timeline', 'cal'], ['Additional information', 'layout']]
const TIPS = ['Choose Tender or Quote – it decides the workflow stages.', 'Set a realistic expected close date; forecasts use it.', 'Value above your approval threshold may need approval to move stages.']
const nowT = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

interface V { name: string; customer: Opt | null; pipeline: string; value: string; close: string; owner: Opt | null; source: Opt | null; emd: boolean; custom: Record<string, string | boolean> }
// API field (DealIn) → form field
const API_MAP: Record<string, string> = {
  name: 'name', customer_id: 'customer', pipeline: 'pipeline', value: 'value', close: 'close', owner_id: 'owner', source_id: 'source', emd_required: 'emd', custom_data: 'cf_',
}
const blank = (owner: Opt | null): V => ({ name: '', customer: null, pipeline: '', value: '', close: '', owner, source: null, emd: false, custom: {} })

export default function DealFormV17() {
  const { id: idParam } = useParams()
  const editId = idParam ? Number(idParam) : null
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const user = useAuthStore(s => s.user)
  const tenant = useAuthStore(s => s.tenant_slug)
  const { fields: cfg } = useFormConfig('opportunities')
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
  const [dups, setDups] = useState<{ id: number; ref: string; name: string; same_name: boolean }[]>([])
  const refs = useRef<Record<string, HTMLElement | null>>({})
  const dirty = useRef(false)
  const draftKey = `deal-form-draft:${tenant || ''}:${user?.id || ''}`

  const [custQ, setCustQ] = useState('')
  const customers = useMaster(() => dealApi.customers(custQ), [custQ])
  const sources = useMaster(masters.sources)
  const users = useMaster(masters.users)

  useEffect(() => {
    dealApi.meta().then(m => {
      setMeta(m)
      if (!editId) setV(s => dirty.current || restored ? s : { ...s, owner: s.owner || m.me, pipeline: s.pipeline || m.pipelines[0]?.key || '' })
    }).catch(e => setLoadErr(errMsg(e, 'Could not open the deal form')))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editId) {
      let live = true
      dealApi.get(editId).then(d => {
        if (!live) return
        const f = d.form
        const val: V = {
          name: f.name, customer: f.customer_id ? { id: f.customer_id, name: f.customer_name || '' } : null, pipeline: f.pipeline, value: f.value ? String(f.value) : '',
          close: f.close || '', owner: f.owner_id ? { id: f.owner_id, name: f.owner_name || '' } : null, source: f.source_id ? { id: f.source_id, name: f.source_name || '' } : null,
          emd: f.emd_required, custom: Object.fromEntries(Object.entries(f.custom_data || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')])),
        }
        setV(val); setOrig(val); setRef(d.ref); setReady(true)
      }).catch(e => { if (live) setLoadErr(errMsg(e, 'Could not open this deal')) })
      return () => { live = false }
    }
    const copyId = Number(sp.get('copy')) || null   // row menu → Duplicate: a new deal prefilled from that one
    if (copyId) {
      let live = true
      dealApi.get(copyId).then(d => {
        if (!live) return
        const f = d.form
        dirty.current = true
        setV(s => ({ ...s, name: `${f.name} (copy)`, customer: f.customer_id ? { id: f.customer_id, name: f.customer_name || '' } : null, pipeline: f.pipeline,
          value: f.value ? String(f.value) : '', close: f.close || '', owner: f.owner_id ? { id: f.owner_id, name: f.owner_name || '' } : s.owner,
          source: f.source_id ? { id: f.source_id, name: f.source_name || '' } : null, emd: f.emd_required,
          custom: Object.fromEntries(Object.entries(f.custom_data || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')])) }))
      }).catch(e => { if (live) error(errMsg(e, 'Could not copy that deal')) })
      return () => { live = false }
    }
    const cust = Number(sp.get('customer')) || null   // "New deal" from Customer 360
    let draft: V | null = null
    try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { /* private mode */ }
    if (!cust && draft && (draft.name || draft.customer || draft.value)) { setV(s => ({ ...s, ...draft })); setRestored(true) }
    if (cust) dealApi.customers('').then(L => { const c = L.find(x => x.id === cust); if (c) setV(s => ({ ...s, customer: c })) }).catch(() => { /* lookup still works */ })
  }, [editId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!v.customer) { setDups([]); return }
    const t = setTimeout(() => { dealApi.duplicates(v.customer!.id, v.name, editId ?? undefined).then(setDups).catch(() => setDups([])) }, 300)
    return () => clearTimeout(t)
  }, [v.customer?.id, v.name, editId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editId || !dirty.current) return
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify(v)); setDraftNote(`Draft saved ${nowT()}`) } catch { /* private mode */ } }, 600)
    return () => clearTimeout(t)
  }, [v, editId, draftKey])

  const customs = cfg.filter(f => f.is_custom && f.is_visible).sort((a, b) => a.sort_order - b.sort_order)
  const cfgReq = (k: string) => cfg.some(f => !f.is_custom && f.field_key === k && f.is_required)
  // validation rule per field (custom fields: inferred from their Form Builder type / label + is_required)
  const spec = (id: string): FieldSpec | undefined => {
    if (id.startsWith('cf_')) {
      const c = customs.find(x => x.field_key === id.slice(3))
      return c ? { label: c.label, required: c.is_required, rule: inferRule(c.field_key, c.label, c.field_type) } : undefined
    }
    switch (id) {
      case 'name': return { label: 'Opportunity name', rule: 'name', required: true, min: 2, max: 500 }
      case 'customer': return { label: 'Customer', rule: 'select', required: true }
      case 'pipeline': return { label: 'Workflow type', rule: 'select', required: true }
      case 'source': return { label: 'Source', rule: 'select', required: cfgReq('source_id') }
      case 'value': return { label: 'Value', rule: 'amount', required: cfgReq('est_value') }
      // a new deal cannot be expected to close in the past; an existing deal is never blocked by its old date
      case 'close': return { label: 'Expected close', rule: 'date', required: cfgReq('timeline'), ...(editId ? {} : { minDate: todayISO(), dateLabel: { min: 'today' } }) }
      case 'owner': return { label: 'Owner', rule: 'select', required: cfgReq('assigned_to') }
    }
    return undefined
  }
  const valOf = (id: string): Val => id.startsWith('cf_') ? v.custom[id.slice(3)] : ((v as unknown as Record<string, Val>)[id])
  const leave = (id: string) => fe.blur(id, valOf(id), spec(id))
  const set = <K extends keyof V>(k: K, x: V[K]) => { dirty.current = true; setV(s => ({ ...s, [k]: x })); fe.change(k as string, x as Val, spec(k as string)) }
  const setCustom = (k: string, x: string | boolean) => { dirty.current = true; setV(s => ({ ...s, custom: { ...s.custom, [k]: x } })); fe.change(`cf_${k}`, x, spec(`cf_${k}`)) }

  type F = { id: string; label: string; sec: Sec; req: boolean; w?: 2; help?: string; filled: boolean; node: (bad: boolean) => ReactNode }
  const fields: F[] = useMemo(() => !meta ? [] : [
    { id: 'name', label: 'Opportunity name', sec: 'Basic information', req: true, w: 2, filled: !!v.name.trim(),
      node: bad => <input id="df-name" ref={el => { refs.current.name = el }} className={`in ${bad ? 'err' : ''}`} maxLength={500} value={v.name} onChange={e => set('name', e.target.value)}
        onBlur={() => leave('name')} aria-invalid={bad || undefined} /> },
    { id: 'customer', label: 'Customer', sec: 'Basic information', req: true, filled: !!v.customer,
      node: bad => <Lookup id="df-customer" value={v.customer?.id ?? null} label={v.customer?.name} items={customers.items} error={customers.error} onRetry={customers.reload} onSearch={setCustQ}
        placeholder="Select customer…" emptyText="No customers you can work with" clearable={false} bad={bad} inputRef={el => { refs.current.customer = el }} onChange={o => set('customer', o)} onBlur={() => leave('customer')} /> },
    { id: 'pipeline', label: 'Workflow type', sec: 'Basic information', req: true, help: 'Decides which pipeline stages apply', filled: !!v.pipeline,
      node: bad => <select id="df-pipeline" ref={el => { refs.current.pipeline = el }} className={`in ${bad ? 'err' : ''}`} value={v.pipeline} onChange={e => set('pipeline', e.target.value)}
        onBlur={() => leave('pipeline')} aria-invalid={bad || undefined}>
        <option value="">Select…</option>{meta.pipelines.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</select> },
    { id: 'source', label: 'Source', sec: 'Contact & location', req: cfgReq('source_id'), filled: !!v.source,
      node: bad => <Lookup id="df-source" value={v.source?.id ?? null} label={v.source?.name} items={sources.items} error={sources.error} onRetry={sources.reload} bad={bad}
        inputRef={el => { refs.current.source = el }} emptyText="No active lead sources in Masters" onChange={o => set('source', o)} onBlur={() => leave('source')} /> },
    { id: 'value', label: 'Value', sec: 'Commercials', req: cfgReq('est_value'), filled: !!v.value,
      node: bad => <div className="cur-in"><span>₹</span><input id="df-value" ref={el => { refs.current.value = el }} className={`in ${bad ? 'err' : ''}`} type="number" min={0} step="any" inputMode="decimal"
        value={v.value} onChange={e => set('value', e.target.value)} onBlur={() => leave('value')} aria-invalid={bad || undefined} /></div> },
    { id: 'emd', label: 'EMD required', sec: 'Commercials', req: false, filled: v.emd,
      node: () => <label className="row" style={{ gap: 6 }}><input id="df-emd" type="checkbox" checked={v.emd} onChange={e => set('emd', e.target.checked)} /> Yes</label> },
    { id: 'close', label: 'Expected close', sec: 'Ownership & timeline', req: cfgReq('timeline'), filled: !!v.close,
      node: bad => <input id="df-close" ref={el => { refs.current.close = el }} className={`in ${bad ? 'err' : ''}`} type="date" value={v.close} onChange={e => set('close', e.target.value)}
        onBlur={() => leave('close')} aria-invalid={bad || undefined} /> },
    { id: 'owner', label: 'Owner', sec: 'Ownership & timeline', req: cfgReq('assigned_to'), filled: !!v.owner,
      node: bad => <Lookup id="df-owner" value={v.owner?.id ?? null} label={v.owner?.name} items={users.items} error={users.error} onRetry={users.reload} bad={bad}
        inputRef={el => { refs.current.owner = el }} emptyText="No active users" onChange={o => set('owner', o)} onBlur={() => leave('owner')} /> },
    ...customs.map((c: FormFieldConfig): F => {
      const k = c.field_key, val = v.custom[k], id = `cf_${k}`
      const opts = (c.options || []).map(o => typeof o === 'string' ? { v: o, l: o } : { v: o.value, l: o.label })
      return { id, label: c.label, sec: 'Additional information', req: c.is_required, w: c.col_span === 2 || c.field_type === 'textarea' ? 2 : undefined,
        filled: val !== undefined && val !== '' && val !== false,
        node: bad => {
          const p = { id: `df-${id}`, ref: (el: HTMLElement | null) => { refs.current[id] = el }, className: `in ${bad ? 'err' : ''}`, onBlur: () => leave(id), 'aria-invalid': bad || undefined }
          if (c.field_type === 'select') return <select {...p} value={String(val ?? '')} onChange={e => setCustom(k, e.target.value)}><option value="">Select…</option>{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          if (c.field_type === 'textarea') return <textarea {...p} rows={3} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
          if (c.field_type === 'checkbox') return <label className="row" style={{ gap: 6 }}><input id={p.id} ref={p.ref} type="checkbox" checked={!!val} onChange={e => setCustom(k, e.target.checked)} onBlur={p.onBlur} aria-invalid={p['aria-invalid']} /> Yes</label>
          return <input {...p} type={c.field_type === 'phone' ? 'tel' : c.field_type} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
        } }
    }),
  ], [meta, v, customers, sources, users, customs, errs]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = SECS.map(([s, i]) => [s, i, fields.filter(f => f.sec === s)] as const).filter(g => g[2].length)
  const miss = fields.filter(f => f.req && !f.filled)
  const pct = Math.round(fields.filter(f => f.filled).length / Math.max(fields.length, 1) * 100)
  const pipe = meta?.pipelines.find(p => p.key === v.pipeline)
  const gated = pipe ? pipe.stages.filter(s => s.gate === 'Approval').map(s => s.name) : []
  const show = (f: F, x: V | null): string => {
    if (!x) return ''
    if (f.id.startsWith('cf_')) return String(x.custom[f.id.slice(3)] ?? '')
    const y = (x as unknown as Record<string, unknown>)[f.id === 'emd' ? 'emd' : f.id]
    if (f.id === 'pipeline') return meta?.pipelines.find(p => p.key === y)?.name || ''
    if (typeof y === 'boolean') return y ? 'Yes' : ''
    return y && typeof y === 'object' ? (y as Opt).name : String(y ?? '')
  }
  const changes = orig ? fields.filter(f => show(f, orig) !== show(f, v)) : []
  const jump = (id: string) => { const el = refs.current[id]; if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const reset = () => { setV(blank(meta?.me || null)); setV(s => ({ ...s, pipeline: meta?.pipelines[0]?.key || '' })); setRestored(false); setDraftNote(''); dirty.current = false; fe.clear(); window.scrollTo(0, 0); setTimeout(() => refs.current.name?.focus(), 0) }

  const save = async (again = false) => {
    const bad = fe.validateAll(Object.fromEntries(fields.map(f => [f.id, valOf(f.id)])), Object.fromEntries(fields.map(f => [f.id, spec(f.id)])))
    if (Object.keys(bad).length) { const first = fields.find(f => bad[f.id]); if (first) jump(first.id); return }
    const body = {
      name: v.name.trim(), customer_id: v.customer!.id, pipeline: v.pipeline, value: v.value ? Number(v.value) : null, close: v.close || null, owner_id: v.owner?.id ?? null,
      source_id: v.source?.id ?? null, emd_required: v.emd, custom_data: Object.keys(v.custom).length ? { ...v.custom } : null,
    }
    setBusy(true)
    try {
      const r = editId ? await dealApi.update(editId, body) : await dealApi.create(body)
      if (!editId) { dirty.current = false; try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
      success(editId ? 'Deal updated' : 'Deal created')
      if (again) reset()
      else navigate(`/opportunities?open=${editId || r.id}`)
    } catch (e) {
      // server-side field errors land under their fields; anything else is a toast
      const fx = mapApiErrors(e, API_MAP), known = Object.fromEntries(Object.entries(fx).filter(([k]) => fields.some(f => f.id === k)))
      if (Object.keys(known).length) { fe.setErrors(x => ({ ...x, ...known })); const first = fields.find(f => known[f.id]); if (first) jump(first.id) }
      else error(errMsg(e, editId ? 'Could not save the deal' : 'Could not create the deal'))
    }
    finally { setBusy(false) }
  }
  const cancel = () => navigate(editId ? `/opportunities?open=${editId}` : '/opportunities')
  const discard = () => { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } reset(); warning('Draft discarded') }

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/opportunities')}>Deals</a></div><div className="panel"><div className="empty">{loadErr}</div></div></div>
  if (!ready || !meta) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/opportunities')}>Deals</a> / {editId ? '…' : 'New'}</div><div className="empty">Loading…</div></div>
  if (!editId && !meta.can.create) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/opportunities')}>Deals</a></div><div className="panel"><div className="empty">You do not have permission to create deals.</div></div></div>

  return (
    <div className="bwi fpage">
      <div className="crumb"><a onClick={() => navigate('/opportunities')}>Deals</a> / {editId ? ref || '…' : 'New'}</div>
      <div className="fph">
        <div className="fpi"><Ic n="target" size={22} /></div>
        <div className="fl"><h1>{editId ? 'Edit' : 'New'} deal</h1>
          <div className="mu">{editId ? 'Update the details below. Changes are highlighted and checked against your approval rules.' : 'Fill in the essentials – you can add more detail any time. Fields marked * are required.'}
            {restored && <> · <b>Draft restored</b> · <a onClick={discard}>Discard</a></>}</div></div>
      </div>
      <div className="fp-grid">
        <div className="fp-main">
          {groups.map(([g, icon, L]) => <section className="fsec" key={g}>
            <div className="fsh"><span className="fsi"><Ic n={icon} /></span><b>{g}</b><small className="mu">{L.length} field{L.length > 1 ? 's' : ''}</small></div>
            <div className="fg">{L.map(f => <div key={f.id} className={`${f.w === 2 ? 'f1' : ''} ${orig && changes.includes(f) ? 'chg' : ''}`}>
              <label htmlFor={`df-${f.id}`}>{f.label}{f.req && <b> *</b>}</label>{f.node(!!errs[f.id])}<FieldError id={`df-${f.id}`} msg={errs[f.id]} />{f.help && !errs[f.id] && <small>{f.help}</small>}</div>)}</div>
          </section>)}
        </div>
        <aside className="fp-side">
          <div className="panel"><div className="ph"><Ic n="spark" /> Summary</div><div className="pb">
            <div style={{ fontSize: 15, minHeight: 20, fontWeight: 600 }}>{v.name.trim() || <span className="mu">Untitled</span>}</div>
            <div className="mu" style={{ fontSize: 12 }}>{v.customer?.name || ''}</div>
            <div className="mt row wrap" style={{ gap: 6 }}>{pipe ? <span className={`pill ${pipe.destination === 'tender' ? 'ac' : 'wa'}`}>{pipe.name}</span> : null}{v.value ? <span className="pill ac">{inr(Number(v.value))}</span> : null}{v.owner ? <span className="pill inf">{v.owner.name}</span> : null}</div>
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
          {dups.length > 0 && <div className="note mt" style={{ borderColor: 'var(--bw-wa)' }}><Ic n="alert" /> <b>Possible duplicate</b> – {v.customer?.name} already has {dups.length} open deal{dups.length > 1 ? 's' : ''}<br />
            {dups.map(d => <div key={d.id}><a onClick={() => navigate(`/opportunities?open=${d.id}`)}>{d.ref} – {d.name.slice(0, 40)}</a>{d.same_name && <small className="mu"> · same name</small>}</div>)}</div>}
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
            <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Creating…' : 'Create deal'}</button></>}
      </div>
    </div>
  )
}
