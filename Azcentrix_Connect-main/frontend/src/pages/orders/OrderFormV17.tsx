// Order form – prototype v17 formPage('wo') (/workorders/new, /workorders/:id/edit). FD.wo: Work order title * (wide) ·
// Customer * · PO number · Order value · Start date · Due date · Project manager, grouped by FSEC into Basic information /
// Commercials / Ownership & timeline, + Form Builder fields (Additional information) and – only when a follow-on lifecycle
// exists – Contract type. Side panels Summary / Completeness / duplicates / Tips, sticky Cancel · Create & add another ·
// Create order. Drafts are kept per user in the browser until created or discarded.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { useFormConfig, type FormFieldConfig } from '@/hooks/useFormConfig'
import { useAuthStore } from '@/store'
import Lookup from '@/pages/leads/Lookup'
import { masters, useMaster, type Opt } from '@/pages/leads/leadApi'
import { errMsg, inr, orderApi, type Meta } from './orderApi'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { inferRule, mapApiErrors, type FieldSpec, type Rule, type Val } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/deals/deals.css'
import './orders.css'

type Sec = 'Basic information' | 'Commercials' | 'Ownership & timeline' | 'Additional information'
const SECS: [Sec, string][] = [['Basic information', 'file'], ['Commercials', 'card'], ['Ownership & timeline', 'cal'], ['Additional information', 'layout']]
const TIPS = ['Link the PO number so billing milestones can be tracked.', 'Choose a contract type for follow-on contracts such as service plans.']
const nowT = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

interface V { title: string; customer: Opt | null; po: string; value: string; start: string; due: string; pm: Opt | null; lifecycle: string; custom: Record<string, string | boolean> }
const blank = (): V => ({ title: '', customer: null, po: '', value: '', start: '', due: '', pm: null, lifecycle: 'wo', custom: {} })
// validation rule per built-in field (backend OrderIn); custom fields are inferred from their type / label
const RULE: Record<string, Partial<FieldSpec>> = {
  title: { rule: 'name', min: 3, max: 300 }, customer: { rule: 'select' }, po: { rule: 'text', max: 100 }, lifecycle: { rule: 'select' },
  value: { rule: 'amount' }, start: { rule: 'date' }, due: { rule: 'date' }, pm: { rule: 'select' },
}
// API field → form field
const API_MAP: Record<string, string> = { customer_id: 'customer', pm_id: 'pm', custom_data: 'cf_' }

export default function OrderFormV17() {
  const { id: idParam } = useParams()
  const editId = idParam ? Number(idParam) : null
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const user = useAuthStore(s => s.user)
  const tenant = useAuthStore(s => s.tenant_slug)
  const { fields: cfg } = useFormConfig('work_orders')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [v, setV] = useState<V>(blank)
  const [orig, setOrig] = useState<V | null>(null)
  const [ref, setRef] = useState('')
  const fe = useFieldErrors()
  const errs = fe.errors
  const [busy, setBusy] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [ready, setReady] = useState(!editId)
  const [draftNote, setDraftNote] = useState('')
  const [restored, setRestored] = useState(false)
  const [dups, setDups] = useState<{ id: number; ref: string; title: string; same_po: boolean; same_title: boolean }[]>([])
  const refs = useRef<Record<string, HTMLElement | null>>({})
  const dirty = useRef(false)
  const draftKey = `order-form-draft:${tenant || ''}:${user?.id || ''}`

  const [custQ, setCustQ] = useState('')
  const customers = useMaster(() => orderApi.customers(custQ), [custQ])
  const users = useMaster(masters.users)

  useEffect(() => {
    orderApi.meta().then(m => {
      setMeta(m)
      const lc = sp.get('lifecycle')
      if (!editId && lc && m.lifecycles.some(l => l.key === lc)) setV(s => ({ ...s, lifecycle: lc }))
    }).catch(e => setLoadErr(errMsg(e, 'Could not open the order form')))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editId) {
      let live = true
      orderApi.get(editId).then(d => {
        if (!live) return
        const f = d.form
        const val: V = { title: f.title, customer: f.customer_id ? { id: f.customer_id, name: f.customer_name || '' } : null, po: f.po || '', value: f.value ? String(f.value) : '',
          start: f.start || '', due: f.due || '', pm: f.pm_id ? { id: f.pm_id, name: f.pm_name || '' } : null, lifecycle: d.lifecycle.key,
          custom: Object.fromEntries(Object.entries(f.custom_data || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')])) }
        setV(val); setOrig(val); setRef(d.ref); setReady(true)
      }).catch(e => { if (live) setLoadErr(errMsg(e, 'Could not open this order')) })
      return () => { live = false }
    }
    const copyId = Number(sp.get('copy')) || null     // row menu → Duplicate: a new order prefilled from that one (PO left empty)
    if (copyId) {
      let live = true
      orderApi.get(copyId).then(d => {
        if (!live) return
        const f = d.form
        dirty.current = true
        setV(s => ({ ...s, title: `${f.title} (copy)`, customer: f.customer_id ? { id: f.customer_id, name: f.customer_name || '' } : null, po: '', value: f.value ? String(f.value) : '',
          start: f.start || '', due: f.due || '', pm: f.pm_id ? { id: f.pm_id, name: f.pm_name || '' } : s.pm, lifecycle: d.lifecycle.key,
          custom: Object.fromEntries(Object.entries(f.custom_data || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')])) }))
      }).catch(e => { if (live) error(errMsg(e, 'Could not copy that order')) })
      return () => { live = false }
    }
    let draft: V | null = null
    try { draft = JSON.parse(localStorage.getItem(draftKey) || 'null') } catch { /* private mode */ }
    if (draft && (draft.title || draft.customer || draft.po || draft.value)) { setV(s => ({ ...s, ...draft })); setRestored(true) }
  }, [editId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!v.customer) { setDups([]); return }
    const t = setTimeout(() => { orderApi.duplicates(v.customer!.id, v.title, v.po, editId ?? undefined).then(setDups).catch(() => setDups([])) }, 300)
    return () => clearTimeout(t)
  }, [v.customer?.id, v.title, v.po, editId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (editId || !dirty.current) return
    const t = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify(v)); setDraftNote(`Draft saved ${nowT()}`) } catch { /* private mode */ } }, 600)
    return () => clearTimeout(t)
  }, [v, editId, draftKey])

  const customs = cfg.filter(f => f.is_custom && f.is_visible).sort((a, b) => a.sort_order - b.sort_order)
  const set = <K extends keyof V>(k: K, x: V[K]) => {
    dirty.current = true; setV(s => ({ ...s, [k]: x }))
    const next = { ...v, [k]: x }; check(k as string, x as Val, 'change', next)
    if (k === 'start' && next.due) check('due', next.due, 'blur', next)        // due ≥ start
  }
  const setCustom = (k: string, x: string | boolean) => { dirty.current = true; setV(s => ({ ...s, custom: { ...s.custom, [k]: x } })); check(`cf_${k}`, x, 'change') }
  const valOf = (id: string, x: V = v): Val => id.startsWith('cf_') ? x.custom[id.slice(3)] : (x as unknown as Record<string, Val>)[id]
  const spec = (f: { id: string; label: string; req: boolean; ft?: string }, x: V = v): FieldSpec => ({
    label: f.label, required: f.req, ...(RULE[f.id] ?? { rule: inferRule(f.id.slice(3), f.label, f.ft) as Rule }),
    ...(f.id === 'due' && x.start ? { minDate: x.start, dateLabel: { min: 'the start date' } } : {}),
  })
  const check = (id: string, val: Val, mode: 'change' | 'blur', x: V = v) => {
    const f = fields.find(y => y.id === id); if (!f) return
    if (mode === 'change') fe.change(id, val, spec(f, x)); else fe.blur(id, val, spec(f, x))
  }
  const leave = (id: string) => check(id, valOf(id), 'blur')
  const lcs = meta?.lifecycles || []

  type F = { id: string; label: string; sec: Sec; req: boolean; w?: 2; help?: string; filled: boolean; ft?: string; node: (bad: boolean) => ReactNode }
  const fields: F[] = useMemo(() => !meta ? [] : [
    { id: 'title', label: 'Work order title', sec: 'Basic information', req: true, w: 2, filled: !!v.title.trim(),
      node: bad => <input id="of-title" ref={el => { refs.current.title = el }} className={`in ${bad ? 'err' : ''}`} aria-invalid={bad || undefined} maxLength={300} value={v.title} onChange={e => set('title', e.target.value)} /> },
    { id: 'customer', label: 'Customer', sec: 'Basic information', req: true, filled: !!v.customer,
      node: bad => <Lookup id="of-customer" value={v.customer?.id ?? null} label={v.customer?.name} items={customers.items} error={customers.error} onRetry={customers.reload} onSearch={setCustQ}
        placeholder="Select customer…" emptyText="No customers you can work with" clearable={false} bad={bad} inputRef={el => { refs.current.customer = el }} onChange={o => set('customer', o)} /> },
    { id: 'po', label: 'PO number', sec: 'Basic information', req: false, filled: !!v.po.trim(),
      node: bad => <input id="of-po" ref={el => { refs.current.po = el }} className={`in ${bad ? 'err' : ''}`} aria-invalid={bad || undefined} maxLength={100} value={v.po} onChange={e => set('po', e.target.value)} /> },
    ...(lcs.length > 1 && !editId ? [{ id: 'lifecycle', label: 'Contract type', sec: 'Basic information' as Sec, req: false, help: 'Lifecycles are defined in the Process Designer', filled: true,
      node: () => <select id="of-lifecycle" className="in" value={v.lifecycle} onChange={e => set('lifecycle', e.target.value)}>{lcs.map(l => <option key={l.key} value={l.key}>{l.type}</option>)}</select> }] : []),
    { id: 'value', label: 'Order value', sec: 'Commercials', req: false, filled: !!v.value,
      node: bad => <div className="cur-in"><span>₹</span><input id="of-value" ref={el => { refs.current.value = el }} className={`in ${bad ? 'err' : ''}`} aria-invalid={bad || undefined} type="number" min={0} step="any" inputMode="decimal"
        value={v.value} onChange={e => set('value', e.target.value)} /></div> },
    { id: 'start', label: 'Start date', sec: 'Ownership & timeline', req: false, filled: !!v.start,
      node: bad => <input id="of-start" ref={el => { refs.current.start = el }} className={`in ${bad ? 'err' : ''}`} aria-invalid={bad || undefined} type="date" value={v.start} onChange={e => set('start', e.target.value)} /> },
    { id: 'due', label: 'Due date', sec: 'Ownership & timeline', req: false, filled: !!v.due,
      node: bad => <input id="of-due" ref={el => { refs.current.due = el }} className={`in ${bad ? 'err' : ''}`} aria-invalid={bad || undefined} type="date" min={v.start || undefined} value={v.due} onChange={e => set('due', e.target.value)} /> },
    { id: 'pm', label: 'Project manager', sec: 'Ownership & timeline', req: false, filled: !!v.pm,
      help: meta.config.auto_pm && !v.pm ? 'Left empty – you will be assigned automatically' : undefined,
      node: bad => <Lookup id="of-pm" value={v.pm?.id ?? null} label={v.pm?.name} items={users.items} error={users.error} onRetry={users.reload} bad={bad}
        inputRef={el => { refs.current.pm = el }} emptyText="No active users" onChange={o => set('pm', o)} /> },
    ...customs.map((c: FormFieldConfig): F => {
      const k = c.field_key, val = v.custom[k], id = `cf_${k}`
      const opts = (c.options || []).map(o => typeof o === 'string' ? { v: o, l: o } : { v: o.value, l: o.label })
      return { id, label: c.label, sec: 'Additional information', req: c.is_required, w: c.col_span === 2 || c.field_type === 'textarea' ? 2 : undefined,
        filled: val !== undefined && val !== '' && val !== false, ft: c.field_type,
        node: bad => {
          const p = { id: `of-${id}`, ref: (el: HTMLElement | null) => { refs.current[id] = el }, className: `in ${bad ? 'err' : ''}`, 'aria-invalid': bad || undefined }
          if (c.field_type === 'select') return <select {...p} value={String(val ?? '')} onChange={e => setCustom(k, e.target.value)}><option value="">Select…</option>{opts.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
          if (c.field_type === 'textarea') return <textarea {...p} rows={3} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
          if (c.field_type === 'checkbox') return <label className="row" style={{ gap: 6 }}><input id={p.id} type="checkbox" checked={!!val} onChange={e => setCustom(k, e.target.checked)} /> Yes</label>
          return <input {...p} type={c.field_type === 'phone' ? 'tel' : c.field_type} value={String(val ?? '')} placeholder={c.placeholder} onChange={e => setCustom(k, e.target.value)} />
        } }
    }),
  ], [meta, v, customers, users, customs, errs, lcs, editId]) // eslint-disable-line react-hooks/exhaustive-deps

  const groups = SECS.map(([s, i]) => [s, i, fields.filter(f => f.sec === s)] as const).filter(g => g[2].length)
  const miss = fields.filter(f => f.req && !f.filled)
  const pct = Math.round(fields.filter(f => f.filled).length / Math.max(fields.length, 1) * 100)
  const lc = lcs.find(l => l.key === v.lifecycle)
  const gated = lc ? lc.stages.filter(s => s.gate === 'Approval').map(s => s.name) : []
  const show = (f: F, x: V | null): string => {
    if (!x) return ''
    if (f.id.startsWith('cf_')) return String(x.custom[f.id.slice(3)] ?? '')
    const y = (x as unknown as Record<string, unknown>)[f.id]
    if (f.id === 'lifecycle') return lcs.find(l => l.key === y)?.type || ''
    if (typeof y === 'boolean') return y ? 'Yes' : ''
    return y && typeof y === 'object' ? (y as Opt).name : String(y ?? '')
  }
  const changes = orig ? fields.filter(f => show(f, orig) !== show(f, v)) : []
  const jump = (id: string) => { const el = refs.current[id]; if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const reset = () => { setV({ ...blank(), lifecycle: v.lifecycle }); setRestored(false); setDraftNote(''); dirty.current = false; fe.clear(); setDups([]); window.scrollTo(0, 0); setTimeout(() => refs.current.title?.focus(), 0) }

  const save = async (again = false) => {
    const bad = fe.validateAll(Object.fromEntries(fields.map(f => [f.id, valOf(f.id)])), Object.fromEntries(fields.map(f => [f.id, spec(f)])))
    if (Object.keys(bad).length) { const first = fields.find(f => bad[f.id]); if (first) jump(first.id); return }
    const body = { title: v.title.trim(), customer_id: v.customer!.id, po: v.po.trim() || null, value: v.value ? Number(v.value) : null, start: v.start || null, due: v.due || null,
      pm_id: v.pm?.id ?? null, lifecycle: v.lifecycle || null, custom_data: Object.keys(v.custom).length ? { ...v.custom } : null }
    setBusy(true)
    try {
      const r = editId ? await orderApi.update(editId, body) : await orderApi.create(body)
      if (!editId) { dirty.current = false; try { localStorage.removeItem(draftKey) } catch { /* ignore */ } }
      success(editId ? 'Order updated' : `Order ${(r as { ref?: string }).ref || ''} created`)
      if (again) reset()
      else navigate(`/workorders?open=${editId || r.id}`)
    } catch (e) {
      // server-side field errors (format, duplicate PO, custom fields) land under their fields; anything else is a toast
      const known: Record<string, string> = Object.fromEntries(Object.entries(mapApiErrors(e, API_MAP)).filter(([k]) => fields.some(f => f.id === k)))
      const d = (e as { response?: { data?: { detail?: { missing?: string[] } } } })?.response?.data?.detail
      if (d && typeof d === 'object' && Array.isArray(d.missing)) customs.filter(c => d.missing!.includes(c.label)).forEach(c => { known[`cf_${c.field_key}`] = `${c.label} is required.` })
      if (Object.keys(known).length) { fe.setErrors(x => ({ ...x, ...known })); const first = fields.find(f => known[f.id]); if (first) jump(first.id) }
      else error(errMsg(e, editId ? 'Could not save the order' : 'Could not create the order'))
    } finally { setBusy(false) }
  }
  const cancel = () => navigate(editId ? `/workorders?open=${editId}` : '/workorders')
  const discard = () => { try { localStorage.removeItem(draftKey) } catch { /* ignore */ } reset(); warning('Draft discarded') }

  if (loadErr) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/workorders')}>Orders &amp; Projects</a></div><div className="panel"><div className="empty">{loadErr}</div></div></div>
  if (!ready || !meta) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/workorders')}>Orders &amp; Projects</a> / {editId ? '…' : 'New'}</div><div className="empty">Loading…</div></div>
  if (!editId && !meta.can.create) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/workorders')}>Orders &amp; Projects</a></div><div className="panel"><div className="empty">You do not have permission to create orders.</div></div></div>
  if (editId && !meta.can.update) return <div className="bwi"><div className="crumb"><a onClick={() => navigate('/workorders')}>Orders &amp; Projects</a></div><div className="panel"><div className="empty">You do not have permission to edit orders.</div></div></div>

  return (
    <div className="bwi fpage">
      <div className="crumb"><a onClick={() => navigate('/workorders')}>Orders &amp; Projects</a> / {editId ? ref || '…' : 'New'}</div>
      <div className="fph">
        <div className="fpi"><Ic n="brief" size={22} /></div>
        <div className="fl"><h1>{editId ? 'Edit' : 'New'} order</h1>
          <div className="mu">{editId ? 'Update the details below. Changes are highlighted and checked against your approval rules.' : 'Fill in the essentials – you can add more detail any time. Fields marked * are required.'}
            {restored && <> · <b>Draft restored</b> · <a onClick={discard}>Discard</a></>}</div></div>
      </div>
      <div className="fp-grid">
        <div className="fp-main">
          {groups.map(([g, icon, L]) => <section className="fsec" key={g}>
            <div className="fsh"><span className="fsi"><Ic n={icon} /></span><b>{g}</b><small className="mu">{L.length} field{L.length > 1 ? 's' : ''}</small></div>
            <div className="fg">{L.map(f => <div key={f.id} className={`${f.w === 2 ? 'f1' : ''} ${orig && changes.includes(f) ? 'chg' : ''}`} onBlur={() => leave(f.id)}>
              <label htmlFor={`of-${f.id}`}>{f.label}{f.req && <b> *</b>}</label>{f.node(!!errs[f.id])}<FieldError id={`of-${f.id}`} msg={errs[f.id]} />{f.help && !errs[f.id] && <small>{f.help}</small>}</div>)}</div>
          </section>)}
        </div>
        <aside className="fp-side">
          <div className="panel"><div className="ph"><Ic n="spark" /> Summary</div><div className="pb">
            <div style={{ fontSize: 15, minHeight: 20, fontWeight: 600 }}>{v.title.trim() || <span className="mu">Untitled</span>}</div>
            <div className="mu" style={{ fontSize: 12 }}>{v.customer?.name || ''}</div>
            <div className="mt row wrap" style={{ gap: 6 }}>{lc && lcs.length > 1 ? <span className="pill ac">{lc.type}</span> : null}{v.po.trim() ? <span className="pill inf">{v.po.trim()}</span> : null}
              {v.value ? <span className="pill ac">{inr(Number(v.value))}</span> : null}{v.pm ? <span className="pill inf">{v.pm.name}</span> : null}</div>
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
          {dups.length > 0 && <div className="note mt" style={{ borderColor: 'var(--bw-wa)' }}><Ic n="alert" /> <b>Possible duplicate</b> – {v.customer?.name} already has {dups.length} order{dups.length > 1 ? 's' : ''} like this<br />
            {dups.map(d => <div key={d.id}><a onClick={() => navigate(`/workorders?open=${d.id}`)}>{d.ref} – {d.title.slice(0, 40)}</a>{d.same_po ? <small className="tbad"> · same PO</small> : d.same_title ? <small className="mu"> · same title</small> : null}</div>)}</div>}
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
            <button type="button" className="btn p" onClick={() => save()} disabled={busy}><Ic n="check" /> {busy ? 'Creating…' : 'Create order'}</button></>}
      </div>
    </div>
  )
}
