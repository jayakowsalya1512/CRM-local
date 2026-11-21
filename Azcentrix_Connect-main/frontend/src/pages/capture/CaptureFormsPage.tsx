// Lead capture forms – Bidwise prototype v17 R.capture(): header (Sales · Lead capture forms · "N live · M submissions
// in 30 days" · + New form), five KPI cards, Forms list with publish switches, Fields & routing, Live preview,
// Send a test submission / Copy embed code, Embed code and Recent submissions. Everything is saved in MariaDB and every
// option list (teams, users, lead sources, products, states) comes from the Masters / Users & Teams modules.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av } from '@/pages/customers/kit'
import { ago, capApi, errMsg, fieldErrors, type FieldKey, type Form, type Meta, type Sub } from './captureApi'
import { validate, type FieldSpec, type Rule } from '@/utils/validation'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './capture.css'

function Spark({ v, c = 'var(--bw-ac)' }: { v: number[]; c?: string }) {
  const id = useMemo(() => `cfsg${Math.random().toString(36).slice(2, 8)}`, [])
  if (!v || v.length < 2) return null
  const W = 96, H = 28, mx = Math.max(...v), mn = Math.min(...v)
  const d = v.map((x, i) => `${i ? 'L' : 'M'}${(i * W / (v.length - 1)).toFixed(1)} ${(H - 4 - (x - mn) / ((mx - mn) || 1) * (H - 10)).toFixed(1)}`).join(' ')
  return <svg className="sp" viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={c} stopOpacity=".28" /><stop offset="1" stopColor={c} stopOpacity="0" /></linearGradient></defs>
    <path d={`${d} L${W} ${H} L0 ${H}Z`} fill={`url(#${id})`} /><path d={d} fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

export default function CaptureFormsPage() {
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { success, error } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [forms, setForms] = useState<Form[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [subs, setSubs] = useState<Sub[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const selId = Number(sp.get('form')) || null
  const cur = forms ? (forms.find(f => f.id === selId) || forms[0] || null) : null
  const can = meta?.can

  const loadAll = useCallback(async (formId?: number | null) => {
    try {
      const [m, list] = await Promise.all([capApi.meta(formId ?? undefined), capApi.list()])
      setMeta(m); setForms(list); setLoadErr('')
    } catch (e) { setLoadErr(errMsg(e, 'Could not load capture forms')) }
  }, [])
  useEffect(() => { loadAll(selId) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // masters may change while the page is open (new team, source, product) – re-read them when the window regains focus
  useEffect(() => { const f = () => loadAll(cur?.id); window.addEventListener('focus', f); return () => window.removeEventListener('focus', f) }, [loadAll, cur?.id])
  const loadSubs = useCallback((id: number) => { setSubs(null); capApi.submissions(id).then(setSubs).catch(e => { setSubs([]); error(errMsg(e, 'Could not load submissions')) }) }, [error])
  useEffect(() => { if (cur) loadSubs(cur.id) }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (cur && meta && !meta.routing.some(g => g.items.some(i => i.value === cur.assign))) capApi.meta(cur.id).then(setMeta).catch(() => { /* keep */ }) }, [cur?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const select = (id: number) => setSp(s => { const n = new URLSearchParams(s); n.set('form', String(id)); return n }, { replace: true })
  const patchLocal = (f: Form) => setForms(L => L ? L.map(x => x.id === f.id ? { ...x, ...f } : x) : L)

  // Saves run one after another in click order; only the newest reply is applied, so quick successive clicks never
  // flip a control back to an older state. On an error the list is re-read from the server.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const seq = useRef(0)
  const save = (patch: Parameters<typeof capApi.update>[1], toast?: string) => {
    if (!cur) return
    const id = cur.id, n = ++seq.current
    patchLocal({ ...cur, ...patch } as Form)
    queue.current = queue.current.then(() => capApi.update(id, patch)
      .then(f => { if (n === seq.current) patchLocal(f); if (toast) success(toast) })
      .catch(e => { error(errMsg(e, 'Could not save the change')); capApi.list().then(setForms).catch(() => { /* keep */ }) }))
  }
  const toggleField = (k: FieldKey, on: boolean) => {
    if (!cur || !meta) return
    const order = meta.fields.map(f => f.key)
    const fields = order.filter(x => x === k ? on : cur.fields.includes(x))
    save({ fields })
  }
  const toggleReq = (k: FieldKey, on: boolean) => { if (cur) save({ required: on ? [...cur.required, k] : cur.required.filter(x => x !== k) }) }
  const publish = async (f: Form, on: boolean) => {
    patchLocal({ ...f, on })
    try { await capApi.publish(f.id, on); success(`Form ${on ? 'published' : 'unpublished'}`); capApi.meta(cur?.id).then(setMeta).catch(() => { /* ignore */ }) }
    catch (e) { patchLocal({ ...f, on: !on }); error(errMsg(e, 'Could not change the status')) }
  }
  const create = async () => {
    setBusy(true)
    try {
      const f = await capApi.create()
      setForms(L => [f, ...(L || [])]); select(f.id)
      capApi.meta(f.id).then(setMeta).catch(() => { /* ignore */ })
      success('Form created – edit the fields and publish it')
    } catch (e) { error(errMsg(e, 'Could not create the form')) } finally { setBusy(false) }
  }
  const copy = async () => {
    if (!cur) return
    try { await navigator.clipboard.writeText(cur.embed.code); success('Embed code copied') }
    catch {
      const pre = document.getElementById('cf-code')
      if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r) }
      error('Press Ctrl+C to copy the selected code')
    }
  }

  if (loadErr) return <div className="bwi"><div className="pg"><div><div className="crumb">Sales</div><h1>Lead capture forms</h1></div></div><div className="panel"><div className="empty">{loadErr} · <a onClick={() => loadAll(selId)}>Retry</a></div></div></div>
  if (!meta || !forms) return <div className="bwi"><div className="pg"><div><div className="crumb">Sales</div><h1>Lead capture forms</h1></div></div><div className="empty">Loading…</div></div>

  const k = meta.kpis
  const ro = !can?.update
  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">Sales</div><h1>Lead capture forms</h1></div>
        <span className="cnt">{k.live} live · {k.subs} submissions in 30 days</span>
        <span className="fl" />
        {can?.create && <button type="button" className="btn p" disabled={busy} onClick={create}><Ic n="plus" /> New form</button>}
      </div>
      <div className="strip">
        <div className="st"><div className="sth"><label>Forms</label></div><b>{k.forms}</b></div>
        <div className="st"><div className="sth"><label>Submissions · 30 d</label><span className="spw"><Spark v={k.spark} /></span></div><b>{k.subs}</b></div>
        <div className="st"><div className="sth"><label>Leads created</label></div><b>{k.leads}</b></div>
        <div className="st tok"><div className="sth"><label>Converted to deals</label></div><b>{k.won}</b></div>
        <div className="st"><div className="sth"><label>Spam blocked</label></div><b>{k.spam}</b></div>
      </div>
      <div className="split">
        <div className="panel"><div className="ph">Forms</div>
          <div className="side" role="listbox" aria-label="Forms">
            {forms.length ? forms.map(f => <div key={f.id} role="option" aria-selected={cur?.id === f.id} tabIndex={0} className={cur?.id === f.id ? 'on' : ''}
              onClick={() => select(f.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(f.id) } }}>
              <span className="fl"><b>{f.name}</b><br /><small className="mu">{f.subs} submissions · {f.conv}% convert</small></span>
              <label className="sw" title={f.on ? 'Published – click to unpublish' : 'Unpublished – click to publish'} onClick={e => e.stopPropagation()}>
                <input type="checkbox" checked={f.on} disabled={ro} aria-label={`${f.on ? 'Unpublish' : 'Publish'} ${f.name}`} onChange={e => publish(f, e.target.checked)} /><i />
              </label>
            </div>) : <div className="mu" style={{ cursor: 'default' }}>No forms yet{can?.create ? ' – create one with + New form' : ''}.</div>}
          </div>
        </div>
        {cur ? <div>
          <div className="g g2">
            <div className="panel capf"><div className="ph"><Ic n="layout" /> Fields &amp; routing</div><div className="pb">
              <label className="lb">Fields on the form</label>
              {meta.fields.map(f => {
                const on = cur.fields.includes(f.key), req = cur.required.includes(f.key)
                return <div key={f.key} className="row" style={{ padding: '3px 0', gap: 8 }}>
                  <label className="row fl" style={{ gap: 6 }}><input type="checkbox" checked={on} disabled={ro} data-f={f.key} onChange={e => toggleField(f.key, e.target.checked)} /> {f.label}</label>
                  <label className="row mu" style={{ gap: 4, fontSize: 12 }}><input type="checkbox" checked={req} disabled={ro || !on} data-r={f.key} onChange={e => toggleReq(f.key, e.target.checked)} /> required</label>
                </div>
              })}
              <div className="fg mt">
                <div className="f1"><label htmlFor="cf-asg">Assign new leads to</label>
                  <select id="cf-asg" className="in" value={cur.assign} disabled={ro} onChange={e => save({ assign: e.target.value }, 'Routing saved')}>
                    {meta.routing.map(g => <optgroup key={g.group} label={g.group}>{g.items.map(i => <option key={i.value} value={i.value} disabled={i.disabled && i.value !== cur.assign}>{i.label}{i.sub ? ` · ${i.sub}` : ''}</option>)}</optgroup>)}
                  </select></div>
                <div className="f1"><label htmlFor="cf-src">Lead source</label>
                  <select id="cf-src" className="in" value={cur.source_id ?? ''} disabled={ro} onChange={e => save({ source_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Select…</option>{meta.sources.map(s => <option key={s.id} value={s.id} disabled={!s.active && s.id !== cur.source_id}>{s.name}</option>)}
                  </select></div>
                <div className="f1"><label htmlFor="cf-thx">Thank-you message</label>
                  <Thanks key={cur.id} value={cur.thanks} disabled={ro} onSave={v => save({ thanks: v })} /></div>
                <div className="f1"><label htmlFor="cf-spam">Spam protection</label>
                  <select id="cf-spam" className="in" value={cur.spam} disabled={ro} onChange={e => save({ spam: e.target.value })}>
                    {meta.spam_modes.map(x => <option key={x}>{x}</option>)}
                  </select></div>
              </div>
            </div></div>
            <div className="panel"><div className="ph"><Ic n="eye" /> Live preview</div><div className="pb">
              <div className="capp" aria-label="Live preview">
                <Title key={cur.id} value={cur.name} disabled={ro} onSave={v => save({ name: v })} />
                {cur.fields.map(fk => {
                  const f = meta.fields.find(x => x.key === fk)!
                  return <div key={fk}><label>{f.label}{cur.required.includes(fk) ? ' *' : ''}</label>
                    {f.kind === 'textarea' ? <textarea className="in" rows={2} disabled />
                      : f.kind === 'product' || f.kind === 'state' ? <select className="in" disabled title={f.kind === 'product' ? `${meta.products.length} products / services from Masters` : `${meta.states.length} states from Masters`}><option /></select>
                        : <input className="in" disabled />}</div>
                })}
                <button type="button" className="btn p mt" disabled>Submit</button>
              </div>
              <div className="row mt" style={{ gap: 6, flexWrap: 'wrap' }}>
                {can?.update && <button type="button" className="btn" onClick={() => setTesting(true)}><Ic n="plane" /> Send a test submission</button>}
                <button type="button" className="btn" onClick={copy}><Ic n="copy" /> Copy embed code</button>
              </div>
            </div></div>
          </div>
          <div className="panel mt"><div className="ph">Embed code</div><div className="pb">
            <pre className="code" id="cf-code">{cur.embed.code}{!cur.on ? '\n<!-- not published yet: publish the form to accept submissions -->' : ''}</pre>
          </div></div>
          <div className="panel mt"><div className="ph">Recent submissions</div><div className="pb z">
            {subs === null ? <div className="empty">Loading…</div>
              : !subs.length ? <div className="empty">No submissions yet – send a test submission to see a lead created.</div>
                : <table className="t"><thead><tr><th>Received</th><th>Company</th><th>Contact</th><th>Interest</th><th>Assigned to</th><th>Lead</th></tr></thead>
                  <tbody>{subs.map(s => <tr key={s.id}>
                    <td title={s.received_at ? new Date(s.received_at).toLocaleString('en-IN') : ''}>{ago(s.received_at)}{s.test && <> <span className="pill wa">Test</span></>}</td>
                    <td>{s.company || '—'}</td><td>{s.contact || '—'}</td><td>{s.interest || '—'}</td>
                    <td>{s.assigned_to ? <span className="row" style={{ gap: 5, display: 'inline-flex' }}><Av name={s.assigned_to} />{s.assigned_to}</span> : '—'}</td>
                    <td>{s.lead_id && s.lead_ref
                      ? (can?.leads ? <a onClick={() => navigate(`/leads?open=${s.lead_id}`)}>{s.lead_ref}</a> : s.lead_ref)
                      : s.status === 'error' ? <span className="tbad" title={s.error || ''}>Not created</span> : '—'}
                      {s.status === 'duplicate' && <small className="mu"> · existing</small>}</td>
                  </tr>)}</tbody></table>}
          </div></div>
        </div> : <div className="panel"><div className="empty">Create a form with + New form to start capturing leads.</div></div>}
      </div>
      {testing && cur && <TestModal form={cur} meta={meta} onClose={() => setTesting(false)} onDone={msg => { setTesting(false); success(msg); loadSubs(cur.id); loadAll(cur.id) }} />}
    </div>
  )
}

function Thanks({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  const last = useRef(value)
  const t = useRef<ReturnType<typeof setTimeout>>()
  const flush = (x: string) => { clearTimeout(t.current); if (x !== last.current) { last.current = x; onSave(x) } }
  return <textarea id="cf-thx" className="in" rows={2} value={v} disabled={disabled}
    onChange={e => { const x = e.target.value; setV(x); clearTimeout(t.current); t.current = setTimeout(() => flush(x), 700) }} onBlur={() => flush(v)} />
}

function Title({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [ed, setEd] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  if (!ed) return <h3 className={disabled ? '' : 'ed'} title={disabled ? undefined : 'Click to rename the form'} onClick={() => { if (!disabled) setEd(true) }}>{value}</h3>
  const done = (ok: boolean) => { setEd(false); const x = v.trim(); if (ok && x && x !== value) onSave(x); else setV(value) }
  return <input className="in ttl" autoFocus aria-label="Form name" value={v} maxLength={200} onChange={e => setV(e.target.value)} onBlur={() => done(true)}
    onKeyDown={e => { if (e.key === 'Enter') done(true); else if (e.key === 'Escape') done(false) }} />
}

// "Send a test submission": the real form (fields, master options, spam protection) – submitted through the capture
// pipeline and flagged as a test, so it never counts in KPIs.
function TestModal({ form, meta, onClose, onDone }: { form: Form; meta: Meta; onClose: () => void; onDone: (msg: string) => void }) {
  const { error } = useToast()
  const [ch, setCh] = useState<{ rt: string; captcha: { question: string; token: string } | null } | null>(null)
  const [chErr, setChErr] = useState('')
  const [vals, setVals] = useState<Record<string, string>>(() => ({ contact: meta.me.name || '', email: meta.me.email || '', phone: meta.me.phone || '' }))
  const [ca, setCa] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const loadCh = useCallback(() => { setChErr(''); capApi.challenge(form.id).then(setCh).catch(e => setChErr(errMsg(e, 'Could not prepare the test'))) }, [form.id])
  useEffect(() => { loadCh() }, [loadCh])
  // each answer is checked by its field type and the form's required flag (the server applies the same rules)
  const RULE: Record<string, Rule> = { email: 'email', tel: 'mobile', number: 'amount', textarea: 'textarea', product: 'select', state: 'select', text: 'text' }
  const specOf = (k: string): FieldSpec => {
    const f = meta.fields.find(x => x.key === k)
    const rule = RULE[f?.kind || 'text'] || 'text'
    return { label: f?.label || k, rule, required: form.required.includes(k as FieldKey), max: rule === 'textarea' ? 5000 : rule === 'text' ? (k === 'contact' || k === 'tender' ? 200 : 300) : undefined }
  }
  const touched = useRef(new Set<string>())
  const put = (k: string, m: string) => setErrs(e => { if ((e[k] || '') === m) return e; const n = { ...e }; if (m) n[k] = m; else delete n[k]; return n })
  const set = (k: string, v: string) => {
    setVals(s => ({ ...s, [k]: v }))
    const sp = specOf(k)
    put(k, touched.current.has(k) ? validate(v, sp) : validate(v, { ...sp, required: false }))
  }
  const blur = (k: string) => { touched.current.add(k); put(k, validate(vals[k] || '', specOf(k))) }
  const send = async () => {
    if (!ch) return
    const bad: Record<string, string> = {}
    form.fields.forEach(k => { touched.current.add(k); const m = validate(vals[k] || '', specOf(k)); if (m) bad[k] = m })
    if (ch.captcha && !ca.trim()) bad.captcha = 'Please answer the security question.'
    if (Object.keys(bad).length) {
      setErrs(bad)
      const first = [...form.fields, 'captcha'].find(k => bad[k])
      const el = first ? document.getElementById(first === 'captcha' ? 'cft-ca' : `cft-${first}`) : null
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() }
      return
    }
    setBusy(true)
    try {
      const values = Object.fromEntries(form.fields.map(k => [k, vals[k] || '']))
      const r = await capApi.test(form.id, { values, rt: ch.rt, hp: '', ct: ch.captcha?.token, ca })
      const first = (r.assigned_to || '').split(' ')[0]
      onDone(r.status === 'lead_created' ? `Test submission received – lead ${r.lead_ref} created${first ? ` and assigned to ${first}` : ''}`
        : r.status === 'duplicate' ? `Test submission received – matched open lead ${r.lead_ref}` : `Test submission stored – lead not created: ${r.error || 'see Recent submissions'}`)
    } catch (e) {
      const fe = fieldErrors(e)
      setErrs(fe); error(errMsg(e, 'Test submission failed'))
      if (fe.captcha || (e as { response?: { status?: number } })?.response?.status === 409) { setCa(''); loadCh() }
    } finally { setBusy(false) }
  }
  return <Modal title="Send a test submission" width={520} onClose={onClose} foot={<><small className="fl mu">Creates a real lead marked <b>[TEST]</b> – it is left out of the KPIs.</small>
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || !ch} onClick={send}><Ic n="plane" /> {busy ? 'Sending…' : 'Send'}</button></>}>
    {chErr ? <div className="note bad">{chErr} · <a onClick={loadCh}>Retry</a></div> : <div className="fg">
      {form.fields.map(k => {
        const f = meta.fields.find(x => x.key === k)!, req = form.required.includes(k), cls = `in ${errs[k] ? 'bad' : ''}`, id = `cft-${k}`
        return <div key={k} className={f.kind === 'textarea' || k === 'name' ? 'f1' : ''}>
          <label htmlFor={id}>{f.label}{req && <b className="tbad"> *</b>}</label>
          {f.kind === 'textarea' ? <textarea id={id} className={cls} rows={2} value={vals[k] || ''} onChange={e => set(k, e.target.value)} onBlur={() => blur(k)} aria-invalid={errs[k] ? true : undefined} />
            : f.kind === 'product' ? <select id={id} className={cls} value={vals[k] || ''} onChange={e => set(k, e.target.value)} onBlur={() => blur(k)} aria-invalid={errs[k] ? true : undefined}><option value="">Select…</option>{meta.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              : f.kind === 'state' ? <select id={id} className={cls} value={vals[k] || ''} onChange={e => set(k, e.target.value)} onBlur={() => blur(k)} aria-invalid={errs[k] ? true : undefined}><option value="">Select…</option>{meta.states.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                : <input id={id} className={cls} type={f.kind === 'number' ? 'number' : f.kind === 'email' ? 'email' : f.kind === 'tel' ? 'tel' : 'text'} value={vals[k] || ''} onChange={e => set(k, e.target.value)} onBlur={() => blur(k)} aria-invalid={errs[k] ? true : undefined} />}
          {errs[k] && <div className="err">{errs[k]}</div>}
        </div>
      })}
      {ch?.captcha && <div className="f1"><label htmlFor="cft-ca">{ch.captcha.question}<b className="tbad"> *</b></label>
        <input id="cft-ca" className={`in ${errs.captcha ? 'bad' : ''}`} inputMode="numeric" value={ca} onChange={e => { setCa(e.target.value); if (e.target.value.trim()) put('captcha', '') }} />{errs.captcha && <div className="err">{errs.captcha}</div>}</div>}
      {!ch && <div className="f1 mu">Preparing…</div>}
    </div>}
  </Modal>
}
