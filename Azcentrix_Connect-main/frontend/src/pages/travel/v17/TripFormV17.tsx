// New / Edit trip – prototype v17 formPage('travel'): crumb "Travel / New", header (send icon, "New trip"), sections
// Basic information (Traveller* · Purpose* · From · To* · Mode) · Commercials (Estimated cost · Advance) · Ownership & timeline
// (Departure · Return), side Summary / Completeness / Tips, sticky bar Cancel · Create & add another · Create trip.
// Saving submits the trip to the configured travel approval policy (status Pending, or Approved when approval is off).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { errMsg, inr, moneyOk, trApi, type Meta, type TripInput } from './travelApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './travel.css'

type F = TripInput
const blank = (me: number | null): F => ({ traveller_id: me, purpose: '', from: '', to: '', start: '', end: '', mode: 'Train', cost: '', advance: '' })
const LABEL: Record<string, string> = { traveller_id: 'Traveller', purpose: 'Purpose', to: 'To', from: 'From', start: 'Departure', end: 'Return', cost: 'Estimated cost', advance: 'Advance' }

export default function TripFormV17() {
  const { id } = useParams()
  const editId = Number(id) || null
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [v, setV] = useState<F>(blank(null))
  const [loaded, setLoaded] = useState(!editId)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof F>(k: K, val: F[K]) => setV(s => ({ ...s, [k]: val }))

  useEffect(() => { trApi.meta().then(m => { setMeta(m); if (!editId) setV(s => ({ ...s, traveller_id: s.traveller_id ?? m.me.id })) }).catch(e => error('Could not load the form', errMsg(e))) }, [editId, error])
  useEffect(() => {
    if (!editId) return
    trApi.get(editId).then(d => {
      if (!d.actions.edit) { warning('This trip can no longer be edited', `It is ${d.status.toLowerCase()}`); navigate(`/travel?open=${d.id}`, { replace: true }); return }
      setV({ traveller_id: d.traveller_id, purpose: d.purpose, from: d.from, to: d.to, start: d.start || '', end: d.end || '', mode: ['Flight', 'Train', 'Car'].includes(d.mode) ? d.mode : 'Train', cost: d.cost ? String(d.cost) : '', advance: d.advance ? String(d.advance) : '' })
      setLoaded(true)
    }).catch(e => { error('Could not open the trip', errMsg(e)); navigate('/travel', { replace: true }) })
  }, [editId]) // eslint-disable-line react-hooks/exhaustive-deps

  const errs = useMemo(() => {
    const e: Record<string, string> = {}
    if (!v.traveller_id) e.traveller_id = 'Choose the traveller'
    if (v.purpose.trim().length < 3) e.purpose = 'Enter the purpose (at least 3 characters)'
    if (v.from.trim().length < 2) e.from = 'Enter where the trip starts'
    if (v.to.trim().length < 2) e.to = 'Enter the destination'
    else if (v.from.trim() && v.from.trim().toLowerCase() === v.to.trim().toLowerCase()) e.to = 'Destination must differ from the origin'
    if (!v.start) e.start = 'Choose the departure date'
    if (!v.end) e.end = 'Choose the return date'
    else if (v.start && v.start > v.end) e.end = 'Return cannot be before departure'
    if (v.cost.trim() && !moneyOk(v.cost)) e.cost = 'Enter a valid amount (0 or more, up to 2 decimals)'
    if (v.advance.trim() && !moneyOk(v.advance)) e.advance = 'Enter a valid amount (0 or more, up to 2 decimals)'
    else if (v.advance.trim() && v.cost.trim() && Number(v.advance) > Number(v.cost) && Number(v.cost) > 0) e.advance = 'Advance cannot exceed the estimated cost'
    return e
  }, [v])
  const req = ['traveller_id', 'purpose', 'from', 'to', 'start', 'end']
  const filled = (['traveller_id', 'purpose', 'from', 'to', 'start', 'end', 'mode', 'cost', 'advance'] as (keyof F)[]).filter(k => String(v[k] ?? '').trim()).length
  const missing = req.filter(k => !String(v[k as keyof F] ?? '').trim())
  const pct = Math.round(filled / 9 * 100)

  const save = async (again: boolean) => {
    setTouched(true)
    if (Object.keys(errs).length) { error('Please fill the required fields', Object.values(errs)[0]); return }
    if (busy) return
    setBusy(true)
    const body = { ...v, purpose: v.purpose.trim(), from: v.from.trim(), to: v.to.trim(), cost: v.cost.trim() || '0', advance: v.advance.trim() || '0' }
    try {
      if (editId) {
        const r = await trApi.update(editId, body)
        success('Trip saved', r.message || `Status: ${r.status}`)
        navigate(`/travel?open=${editId}`)
      } else {
        const r = await trApi.create(body)
        success(`Trip ${r.code} created`, r.message || `Status: ${r.status}`)
        if (again) { setV(blank(meta?.me.id ?? null)); setTouched(false); window.scrollTo?.(0, 0) } else navigate(`/travel?open=${r.id}`)
      }
    } catch (e) { error('Trip not saved', errMsg(e)) } finally { setBusy(false) }
  }

  const fe = (k: string) => touched && errs[k] ? <div className="ferr">{errs[k]}</div> : null
  const bad = (k: string) => touched && errs[k] ? 'bad' : ''
  const traveller = meta?.travellers.find(t => t.id === v.traveller_id)
  if (!loaded) return <div className="bwi trv"><div className="empty">Loading…</div></div>

  return <div className="bwi trv">
    <div className="crumb"><a onClick={() => navigate('/travel')}>Travel</a> / {editId ? v.purpose.slice(0, 40) : 'New'}</div>
    <div className="fph"><div className="fpi"><Ic n="plane" /></div><div className="fl"><h1>{editId ? 'Edit' : 'New'} trip</h1>
      <div className="mu">{editId ? 'Update the details below. Saving sends the trip for approval again.' : 'Fill in the essentials – you can add more detail any time. Fields marked * are required.'}</div></div></div>
    <div className="fp-grid"><div className="fp-main">
      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="file" /></span><b>Basic information</b><small className="mu">5 fields</small></div>
        <div className="fgrid">
          <div><label>Traveller *</label><select className={`in ${bad('traveller_id')}`} value={v.traveller_id ?? ''} disabled={!!editId} onChange={e => set('traveller_id', Number(e.target.value) || null)}>
            <option value="">— select —</option>{(meta?.travellers || []).map(t => <option key={t.id} value={t.id}>{t.name}{t.department ? ` · ${t.department}` : ''}</option>)}</select>{fe('traveller_id')}</div>
          <div className="w2"><label>Purpose *</label><input className={`in ${bad('purpose')}`} maxLength={500} value={v.purpose} onChange={e => set('purpose', e.target.value)} placeholder="e.g. Pre-bid meeting at customer site" />{fe('purpose')}</div>
          <div><label>From *</label><input className={`in ${bad('from')}`} maxLength={100} value={v.from} onChange={e => set('from', e.target.value)} placeholder="City" />{fe('from')}</div>
          <div><label>To *</label><input className={`in ${bad('to')}`} maxLength={100} value={v.to} onChange={e => set('to', e.target.value)} placeholder="City" />{fe('to')}</div>
          <div><label>Mode</label><select className="in" value={v.mode} onChange={e => set('mode', e.target.value)}>{(meta?.modes || ['Flight', 'Train', 'Car']).map(m => <option key={m}>{m}</option>)}</select></div>
        </div></section>
      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="card" /></span><b>Commercials</b><small className="mu">2 fields</small></div>
        <div className="fgrid">
          <div><label>Estimated cost</label><input className={`in ${bad('cost')}`} inputMode="decimal" value={v.cost} onChange={e => set('cost', e.target.value)} placeholder="₹" />{fe('cost')}</div>
          <div><label>Advance</label><input className={`in ${bad('advance')}`} inputMode="decimal" value={v.advance} onChange={e => set('advance', e.target.value)} placeholder="₹ (optional)" />{fe('advance')}</div>
        </div></section>
      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="cal" /></span><b>Ownership &amp; timeline</b><small className="mu">2 fields</small></div>
        <div className="fgrid">
          <div><label>Departure *</label><input className={`in ${bad('start')}`} type="date" value={v.start} onChange={e => set('start', e.target.value)} />{fe('start')}</div>
          <div><label>Return *</label><input className={`in ${bad('end')}`} type="date" min={v.start || undefined} value={v.end} onChange={e => set('end', e.target.value)} />{fe('end')}</div>
        </div></section>
    </div>
    <aside className="fp-side">
      <div className="panel"><div className="ph"><Ic n="spark" /> Summary</div><div className="pb">
        <div className="b" style={{ fontSize: 15, minHeight: 20 }}>{v.purpose || <span className="mu">Untitled</span>}</div>
        <div className="mu" style={{ fontSize: 12 }}>{traveller?.name || ''}{v.to ? ` · ${v.from || '…'} → ${v.to}` : ''}</div>
        {Number(v.cost) > 0 && <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>{inr(Number(v.cost))}</div>}
      </div></div>
      <div className="panel mt"><div className="ph"><Ic n="check" /> Completeness</div><div className="pb">
        <div className="pm"><i style={{ width: `${pct}%`, background: missing.length ? 'var(--bw-wa)' : 'var(--bw-ok)' }} /></div>
        <div className="mt" style={{ fontSize: 12 }}>{missing.length ? <><span className="twarn">{missing.length} required:</span> {missing.map(k => LABEL[k]).join(', ')}</>
          : <span className="tok"><Ic n="check" size={12} /> All required fields are filled · {pct}% complete</span>}</div>
      </div></div>
      <div className="panel mt"><div className="ph"><Ic n="spark" /> Tips</div><div className="pb"><ul className="tips">
        <li>Required fields are marked with *.</li><li>Everything you enter here can be changed later.</li></ul></div></div>
    </aside></div>
    <div className="fmbar"><span className="mu">{editId ? 'Editing trip' : 'Saving sends the trip for approval'}</span><span className="fl" />
      <button type="button" className="btn" onClick={() => navigate(editId ? `/travel?open=${editId}` : '/travel')}>Cancel</button>
      {editId ? <button type="button" className="btn p" disabled={busy || !meta} onClick={() => save(false)}><Ic n="check" /> {busy ? 'Saving…' : 'Save changes'}</button>
        : <><button type="button" className="btn" disabled={busy || !meta} onClick={() => save(true)}>Create &amp; add another</button>
          <button type="button" className="btn p" disabled={busy || !meta} onClick={() => save(false)}><Ic n="check" /> {busy ? 'Saving…' : 'Create trip'}</button></>}
    </div>
  </div>
}
