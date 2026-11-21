// Field Sales 360 → Log activity – prototype v17 activity composer (R.__act): 1 · What kind of activity · 2 · With whom ·
// 3 · When and where (GPS check-in) · 4 · What was discussed · 5 · Outcome and next step · 6 · Expenses & attachments,
// with the Customer snapshot / This activity side panels and the sticky Cancel · Log & add another · Log activity bar.
// Saves through POST /api/v1/field-sales/activities (which reuses the KAM module's activity creation).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import api from '@/services/api'
import { errMsg, fd, inr } from '@/pages/customers/customerApi'
import { captureGps, fsApi, type FormMeta, type Gps } from './fieldSalesApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './fs360.css'

const ACTT: [string, string, string][] = [['Site Visit', 'pin', 'On-site meeting at the customer'], ['Call', 'mail', 'Phone or video call'], ['Meeting', 'users', 'Meeting at office / online'],
  ['Demo', 'spark', 'Product or solution demo'], ['Email', 'mail', 'Email exchange logged'], ['Follow-up', 'clock', 'Follow-up on a pending item']]
const TPL: Record<string, string> = {
  'Pre-bid clarification': 'Discussed pre-bid queries and clarifications.\n• Queries raised:\n• Customer response:\n• Corrigendum expected:',
  'Technical discussion': 'Technical discussion with the customer team.\n• Scope reviewed:\n• Open technical points:\n• OEM / specification notes:',
  'Commercial negotiation': 'Commercial discussion.\n• Price expectation:\n• Payment terms:\n• Discount asked / offered:',
  'Payment follow-up': 'Follow-up on payment.\n• Invoice(s):\n• Promised date:\n• Escalation needed:',
  'Relationship visit': 'Relationship / courtesy visit.\n• Key people met:\n• Upcoming projects mentioned:\n• Feedback on service:',
}
const TAGS = ['Pricing', 'Technical', 'Delivery', 'Payment', 'Competition', 'Relationship', 'Compliance', 'Documentation']
const WHERE = ['Customer site', 'Our office', 'Phone', 'Video call', 'Tender portal / pre-bid meeting', 'Factory / OEM works']
const OUTS: [string, string, string][] = [['Positive', 'Positive', 'tok'], ['Neutral', 'Neutral', ''], ['Negative', 'Negative', 'tbad'], ['Follow-up needed', 'Follow-up', 'twarn']]
const SENT = ['', 'Cold', 'Cool', 'Neutral', 'Warm', 'Hot']
const p2 = (n: number) => String(n).padStart(2, '0')
const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }
const plus = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` }
const nowT = () => { const d = new Date(); return `${p2(d.getHours())}:${p2(d.getMinutes())}` }

type Mode = 'log' | 'check_in' | 'plan'
const blank = (customer: number | null, kam: number | null) => ({
  type: 'Site Visit', mode: 'log' as Mode, customer, kam, contact: null as number | null, link: '', date: today(), time: nowT(), dur: 30, where: 'Customer site',
  notes: '', tags: [] as string[], comp: '', who: [] as string[], outcome: 'Positive', sent: 4,
  nextOn: true, nextT: '', nextD: plus(3), exp: '', expCat: 'Travel', km: '', file: null as File | null,
})

export default function LogActivityPage() {
  const navigate = useNavigate()
  const loc = useLocation()
  const [sp] = useSearchParams()
  const st = (loc.state || {}) as { back?: string; kam?: number; customer?: number }
  const back = st.back || '/kam'
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<FormMeta | null>(null)
  const [v, setV] = useState(() => blank(st.customer ?? (Number(sp.get('customer')) || null), st.kam ?? null))
  const [gps, setGps] = useState<{ fix: Gps | null; perm: string } | null>(null)
  const [locating, setLocating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [bad, setBad] = useState<Record<string, boolean>>({})
  const fileRef = useRef<HTMLInputElement>(null)
  const set = <K extends keyof typeof v>(k: K, val: (typeof v)[K]) => setV(s => ({ ...s, [k]: val }))

  useEffect(() => {
    fsApi.formMeta(v.customer).then(m => {
      setMeta(m)
      setV(s => ({ ...s, kam: s.kam ?? m.me }))
    }).catch(e => error('Could not load the activity form', errMsg(e)))
  }, [v.customer]) // eslint-disable-line react-hooks/exhaustive-deps

  const me = meta?.users.find(u => u.id === meta.me)?.name || ''
  const kamName = meta?.kams.find(k => k.id === v.kam)?.name || me
  const isVisit = v.type === 'Site Visit'
  const mode: Mode = isVisit ? v.mode : 'log'
  const ownVisit = v.kam === meta?.me
  const snap = meta?.snapshot

  const checkIn = async () => {
    setLocating(true)
    const r = await captureGps()
    setLocating(false)
    setGps({ fix: r.gps, perm: r.perm })
    if (r.gps) success('Location captured', r.gps.accuracy != null && r.gps.accuracy > 200 ? 'Accuracy is low – this check-in will show as Manual' : undefined)
    else warning('Location not captured', r.perm === 'denied' ? 'Location permission was denied – the visit is recorded as Manual' : 'Your device could not provide a location')
  }

  const save = async (again: boolean) => {
    const miss: Record<string, boolean> = {}
    if (!v.customer) miss.customer = true
    if (mode === 'log' && v.date > today()) miss.date = true
    if (v.nextOn && v.nextT.trim() && !v.nextD) miss.nextD = true
    if (v.exp && !(Number(v.exp) >= 0)) miss.exp = true
    if (v.km && !(Number(v.km) >= 0 && Number(v.km) <= 5000)) miss.km = true
    setBad(miss)
    if (Object.keys(miss).length) { error('Please check the highlighted fields', miss.date ? 'A completed activity cannot be dated in the future – choose “Plan for later”' : undefined); return }
    setBusy(true)
    try {
      const r = await fsApi.log({
        action: mode, type: v.type, customer_id: v.customer!, kam_id: v.kam, contact_id: v.contact, date: mode === 'check_in' ? today() : v.date,
        time: v.time || null, duration: mode === 'log' ? v.dur : null, where: v.where,
        link_kind: v.link ? (v.link.split(':')[0] as 'lead' | 'tender') : null, link_id: v.link ? Number(v.link.split(':')[1]) : null,
        notes: v.notes, topics: v.tags, competitor: v.comp || null, attendees: v.who, outcome: mode === 'log' ? (OUTS.find(o => o[0] === v.outcome)?.[1] || null) : null,
        sentiment: v.sent, gps: ownVisit ? gps?.fix ?? null : null, gps_permission: ownVisit ? gps?.perm ?? null : null,
        next_title: v.nextOn && v.nextT.trim() ? v.nextT.trim() : null, next_due: v.nextOn && v.nextT.trim() ? v.nextD : null,
        expense: v.exp ? Number(v.exp) : null, expense_category: v.exp ? v.expCat : null, distance_km: v.km ? Number(v.km) : null,
      })
      if (v.file) {
        const fdta = new FormData(); fdta.append('file', v.file)
        try { await api.post(`/field-sales/activities/${r.id}/attachment`, fdta, { headers: { 'Content-Type': 'multipart/form-data' } }) }
        catch (e) { warning('Activity saved, attachment not uploaded', errMsg(e)) }
      }
      success(mode === 'check_in' ? 'Checked in – visit started' : mode === 'plan' ? 'Visit planned' : 'Activity logged',
        [r.followup_task && 'follow-up task created', v.exp && 'expense recorded'].filter(Boolean).join(' · ') || undefined)
      if (again) { setV(blank(v.customer, v.kam)); setGps(null); window.scrollTo?.(0, 0) }
      else navigate(back)
    } catch (e) { error('Activity not saved', errMsg(e)) } finally { setBusy(false) }
  }

  const chips = (L: string[], sel: string[], on: (t: string) => void) => <div className="row wrap" style={{ gap: 5 }}>{L.map(t => <span key={t} role="button" tabIndex={0} className={`chip ${sel.includes(t) ? 'on' : ''}`} onClick={() => on(t)}>{t}</span>)}</div>
  const custOpts = useMemo(() => meta?.customers || [], [meta])

  return <div className="bwi fs360">
    <div className="crumb"><a onClick={() => navigate(back)}>Field Sales 360</a> / Log activity</div>
    <div className="fph"><div className="fpi"><Ic n="pin" /></div><div className="fl"><h1>Log activity</h1><div className="mu">Capture what happened, what was agreed and what happens next – this feeds the customer timeline, KAM scorecard and reminders.</div></div></div>
    <div className="fp-grid"><div className="fp-main">
      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="layout" /></span><b>1 · What kind of activity?</b></div>
        <div className="atiles">{ACTT.map(([t, i, s]) => <div key={t} role="button" tabIndex={0} className={`atile ${v.type === t ? 'on' : ''}`} onClick={() => set('type', t)}><Ic n={i} /><b>{t}</b><small>{s}</small></div>)}</div></section>

      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="building" /></span><b>2 · With whom</b></div>
        <div className="fg">
          <div><label>Customer *</label><select className={`in ${bad.customer ? 'bad' : ''}`} value={v.customer ?? ''} onChange={e => setV(s => ({ ...s, customer: Number(e.target.value) || null, contact: null, link: '' }))}>
            <option value="">— select —</option>{custOpts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><label>Contact person</label><select className="in" value={v.contact ?? ''} onChange={e => set('contact', Number(e.target.value) || null)}>
            <option value="">— select —</option>{(meta?.contacts || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><label>Related record</label><select className="in" value={v.link} onChange={e => set('link', e.target.value)}>
            <option value="">None</option>{(meta?.links || []).map(l => <option key={`${l.k}:${l.id}`} value={`${l.k}:${l.id}`}>{l.l}</option>)}</select></div>
          <div><label>KAM</label><select className="in" value={v.kam ?? ''} onChange={e => { set('kam', Number(e.target.value) || null); setGps(null) }} disabled={!meta || meta.kams.length <= 1}>
            {meta && !meta.kams.some(k => k.id === meta.me) && <option value={meta.me}>{me}</option>}
            {(meta?.kams || []).map(k => <option key={k.id} value={k.id}>{k.name}</option>)}</select></div>
          <div className="f1"><label>Also present</label><select className="in" value="" onChange={e => { const n = e.target.value; if (n) setV(s => ({ ...s, who: [...s.who, n] })) }}>
            <option value="">+ add colleague…</option>{(meta?.users || []).filter(u => u.name !== kamName && !v.who.includes(u.name)).map(u => <option key={u.id}>{u.name}</option>)}</select></div>
        </div>
        <div className="row wrap mt" style={{ gap: 5 }}>{kamName && <span className="chip on">{kamName}</span>}{v.who.map(n => <span key={n} className="chip on">{n} <a role="button" onClick={() => setV(s => ({ ...s, who: s.who.filter(x => x !== n) }))}>✕</a></span>)}</div></section>

      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="cal" /></span><b>3 · When and where</b></div>
        {isVisit && <div className="row wrap mb" style={{ gap: 5 }}>{([['log', 'Completed visit'], ['check_in', 'Start visit now (check in)'], ['plan', 'Plan for later']] as [Mode, string][]).map(([m, l]) =>
          <span key={m} role="button" tabIndex={0} className={`chip ${v.mode === m ? 'on' : ''}`} onClick={() => set('mode', m)} aria-disabled={m === 'check_in' && !ownVisit}
            title={m === 'check_in' && !ownVisit ? 'Only the KAM on the visit can check in' : undefined} style={m === 'check_in' && !ownVisit ? { opacity: .5, pointerEvents: 'none' } : undefined}>{l}</span>)}</div>}
        <div className="fg">
          <div><label>Date</label><input className={`in ${bad.date ? 'bad' : ''}`} type="date" value={mode === 'check_in' ? today() : v.date} disabled={mode === 'check_in'} onChange={e => set('date', e.target.value)} /></div>
          <div><label>Start time</label><input className="in" type="time" value={mode === 'check_in' ? nowT() : v.time} disabled={mode === 'check_in'} onChange={e => set('time', e.target.value)} /></div>
          {mode === 'log' && <div><label>Duration</label><div className="row wrap" style={{ gap: 5 }}>{[15, 30, 45, 60, 90, 120].map(m => <span key={m} role="button" tabIndex={0} className={`chip ${v.dur === m ? 'on' : ''}`} onClick={() => set('dur', m)}>{m < 60 ? `${m} min` : `${m / 60} h`}</span>)}</div></div>}
          <div><label>Location</label><select className="in" value={v.where} onChange={e => set('where', e.target.value)}>{WHERE.map(x => <option key={x}>{x}</option>)}</select></div>
        </div>
        {mode !== 'plan' && <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
          {!ownVisit ? <small className="mu">GPS check-in is available only to the KAM on the visit.</small>
            : gps?.fix ? <span className={`pill ${gps.fix.accuracy != null && gps.fix.accuracy <= 200 ? 'ok' : 'wa'}`}><Ic n="pin" size={12} /> Checked in · {gps.fix.accuracy != null ? `${Math.round(gps.fix.accuracy)} m accuracy · ` : ''}{gps.fix.lat.toFixed(4)}°N {gps.fix.lng.toFixed(4)}°E</span>
            : <button type="button" className="btn s" disabled={locating} onClick={checkIn}><Ic n="pin" /> {locating ? 'Locating…' : 'Check in with GPS'}</button>}
          {gps && !gps.fix && <span className="pill wa">Manual – {gps.perm === 'denied' ? 'permission denied' : 'location unavailable'}</span>}
          {ownVisit && <small className="mu">Your location is read once, only when you press the button.</small>}
        </div>}</section>

      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="note" /></span><b>4 · What was discussed</b></div>
        <label className="lb">Quick templates</label>
        <div className="row wrap mb" style={{ gap: 5 }}>{Object.keys(TPL).map(t => <span key={t} role="button" tabIndex={0} className="chip" onClick={() => set('notes', (v.notes ? v.notes + '\n\n' : '') + TPL[t])}>{t}</span>)}</div>
        <textarea className="in" rows={6} value={v.notes} onChange={e => set('notes', e.target.value)} placeholder="Summary, decisions, objections, commitments…" />
        <label className="lb mt">Topics</label>{chips(TAGS, v.tags, t => set('tags', v.tags.includes(t) ? v.tags.filter(x => x !== t) : [...v.tags, t]))}
        <div className="fg mt"><div><label>Competitor mentioned</label><select className="in" value={v.comp} onChange={e => set('comp', e.target.value)}><option value="">None</option>{(meta?.competitors || []).map(x => <option key={x}>{x}</option>)}</select></div></div></section>

      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="check" /></span><b>5 · Outcome and next step</b></div>
        {mode === 'log' ? <div className="atiles s">{OUTS.map(([t, , c]) => <div key={t} role="button" tabIndex={0} className={`atile ${v.outcome === t ? 'on' : ''}`} onClick={() => set('outcome', t)}><b className={c}>{t}</b></div>)}</div>
          : <small className="mu">{mode === 'check_in' ? 'The outcome is recorded when you check out of the visit (Visits & check-ins → Visit log).' : 'The outcome is recorded once the planned visit has happened.'}</small>}
        <div className="row mt" style={{ gap: 12 }}><label className="lb" style={{ margin: 0 }}>Customer sentiment</label>
          <input type="range" min={1} max={5} value={v.sent} onChange={e => set('sent', Number(e.target.value))} style={{ flex: 1, maxWidth: 240 }} /><b>{SENT[v.sent]}</b></div>
        <div className="note inf mt"><label className="row" style={{ gap: 6 }}><input type="checkbox" checked={v.nextOn} onChange={e => set('nextOn', e.target.checked)} /> <b>Create a follow-up task</b></label>
          {v.nextOn && <div className="fg mt"><div className="f1"><label>What needs to happen?</label><input className="in" value={v.nextT} onChange={e => set('nextT', e.target.value)} placeholder="e.g. Send revised price schedule" /></div>
            <div><label>Due date</label><input className={`in ${bad.nextD ? 'bad' : ''}`} type="date" value={v.nextD} onChange={e => set('nextD', e.target.value)} /></div></div>}</div></section>

      <section className="fsec"><div className="fsh"><span className="fsi"><Ic n="card" /></span><b>6 · Expenses & attachments <small className="mu">(optional)</small></b></div>
        <div className="fg">
          <div><label>Expense amount (₹)</label><input className={`in ${bad.exp ? 'bad' : ''}`} type="number" min={0} value={v.exp} onChange={e => set('exp', e.target.value)} placeholder="0" /></div>
          <div><label>Category</label><select className="in" value={v.expCat} onChange={e => set('expCat', e.target.value)}>{['Travel', 'Meals', 'Fuel', 'Accommodation', 'Other'].map(x => <option key={x}>{x}</option>)}</select></div>
          <div><label>Travel distance (km)</label><input className={`in ${bad.km ? 'bad' : ''}`} type="number" min={0} step="0.1" value={v.km} onChange={e => set('km', e.target.value)} placeholder="0" /></div>
        </div>
        <div className="row wrap mt" style={{ gap: 6 }}>
          {v.file && <span className="chip on"><Ic n="doc" size={12} /> {v.file.name} <a role="button" onClick={() => set('file', null)}>✕</a></span>}
          <input ref={fileRef} type="file" hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp" onChange={e => { set('file', e.target.files?.[0] || null); e.target.value = '' }} />
          <button type="button" className="btn s" onClick={() => { if (fileRef.current) { fileRef.current.accept = 'image/*'; fileRef.current.click() } }}><Ic n="upload" /> Add photo</button>
          <button type="button" className="btn s" onClick={() => { if (fileRef.current) { fileRef.current.accept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp'; fileRef.current.click() } }}><Ic n="doc" /> Add file</button>
        </div></section>
    </div>
    <aside className="fp-side">
      <div className="panel"><div className="ph"><Ic n="building" /> Customer snapshot</div><div className="pb">{!snap ? <div className="mu">Select a customer to see context.</div> : <>
        <div className="row" style={{ gap: 8 }}><Ring h={snap.health} /><div className="fl"><b>{snap.name}</b><br /><small className="mu">Tier {snap.tier}{snap.city ? ` · ${snap.city}` : ''}{snap.kam ? ` · KAM ${snap.kam}` : ''}</small></div></div>
        <div className="kv mt"><div><span>Open pipeline</span><span>{inr(snap.open_pipe)}</span></div><div><span>Live bids</span><span>{snap.live_bids}</span></div>
          <div><span>Outstanding</span><span className={snap.outstanding ? 'twarn' : ''}>{inr(snap.outstanding)}</span></div><div><span>Last touch</span><span>{snap.last_touch == null ? 'never' : `${snap.last_touch} d ago`}</span></div></div>
        {snap.recent.length > 0 && <><div className="mt b" style={{ fontSize: 12 }}>Recent interactions</div><div className="tl">{snap.recent.map((a, i) => <div key={i}><b>{a.type}</b> · {fd(a.date)}<br /><small className="mu">{a.note}</small></div>)}</div></>}
      </>}</div></div>
      <div className="panel mt"><div className="ph"><Ic n="spark" /> This activity</div><div className="pb"><div className="kv">
        <div><span>Type</span><span>{v.type}</span></div><div><span>When</span><span>{fd(mode === 'check_in' ? today() : v.date)} {mode === 'check_in' ? 'now' : v.time}</span></div>
        <div><span>Duration</span><span>{mode === 'log' ? `${v.dur} min` : mode === 'check_in' ? 'until check-out' : '—'}</span></div>
        <div><span>Outcome</span><span>{mode === 'log' ? v.outcome : '—'}</span></div><div><span>Topics</span><span>{v.tags.length || '—'}</span></div>
        <div><span>Follow-up</span><span>{v.nextOn && v.nextT.trim() ? fd(v.nextD) : 'None'}</span></div>
      </div></div></div>
    </aside></div>
    <div className="fmbar"><span className="mu">{mode === 'check_in' ? 'Starts the visit now – check out from the Visit log' : 'Saved to the customer timeline and KAM scorecard'}</span><span className="fl" />
      <button type="button" className="btn" onClick={() => navigate(back)}>Cancel</button>
      <button type="button" className="btn" disabled={busy} onClick={() => save(true)}>Log & add another</button>
      <button type="button" className="btn p" disabled={busy || !meta} onClick={() => save(false)}><Ic n="check" /> {busy ? 'Saving…' : mode === 'check_in' ? 'Check in' : mode === 'plan' ? 'Plan visit' : 'Log activity'}</button></div>
  </div>
}

function Ring({ h }: { h: number }) {
  const r = 2 * Math.PI * 17
  return <svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="17" fill="none" stroke="var(--bw-ln2)" strokeWidth="5" />
    <circle cx="22" cy="22" r="17" fill="none" stroke={h < 55 ? 'var(--bw-ba)' : h < 75 ? 'var(--bw-wa)' : 'var(--bw-ok)'} strokeWidth="5" strokeDasharray={`${r * h / 100} ${r}`} transform="rotate(-90 22 22)" />
    <text x="22" y="26" textAnchor="middle" fontSize="11" fontWeight="700" fill="currentColor">{h}</text></svg>
}
