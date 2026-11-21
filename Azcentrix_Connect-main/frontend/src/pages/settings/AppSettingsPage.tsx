// Settings – prototype v17 "p25" R.settings(): crumb "Administration" · h1 "Settings" · "Application settings for <tenant>" ·
// "Search all settings…", left .setnav with the 13 categories (icon · name · short description), right: .setH (icon, name,
// description, "Reset to defaults") then one panel per group of .setrow fields (text · number · time · textarea · select ·
// switch · color · file · chips · list).  Extras exactly as the prototype: Notifications "Who is notified, and how" matrix,
// Numbering "Number series" table, Plan & billing cards + usage + invoices, Mobile "Registered mobile devices", Change history.
// Every change autosaves (toast "Saved · <label>") and is written to the change history.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { applyTheme } from '@/hooks/UseTheme'
import { Modal } from '@/pages/notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { validate, type FieldSpec } from '@/utils/validation'
import { Av, Panel, Pill, Tbl } from '@/pages/customers/kit'
import { appSettingsApi, errMsg, fd, fdt, inr, pct, type Billing, type Category, type Change, type Device, type Field, type Matrix, type Payload, type SeriesRow } from './appSettingsApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './appSettings.css'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

/** prototype setApply(): theme / brand colour / density / animations / sidebar take effect immediately. */
function applyAppearance(key: string, v: unknown) {
  if (key === 'theme') {
    const dark = v === 'Dark' || (v === 'Match system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  }
  if (key === 'color' && typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) applyTheme({ theme_accent: v })
  if (key === 'dens') document.body.classList.toggle('bw-dens-c', v === 'Compact')
  if (key === 'anim') document.body.classList.toggle('bw-noanim', v === false)
  if (key === 'sidebar') document.body.classList.toggle('sb-light', v === 'Light')
}

/** Field rules for text / number settings – mirror NUMBER_RULES / _text_rule in backend app_settings_service.py. */
const NUM: Record<string, [number, number, boolean]> = {
  emp: [0, 10_000_000, true], fxUSD: [0.0001, 100_000, false], fxEUR: [0.0001, 100_000, false], fxGBP: [0.0001, 100_000, false], fxAED: [0.0001, 100_000, false],
  pmin: [6, 64, true], pexp: [0, 3650, true], phist: [0, 24, true], sess: [1, 1440, true], conc: [1, 50, true], lock: [1, 50, true], api: [1, 3650, true],
  bin: [1, 3650, true], arch: [1, 600, true], bkr: [1, 3650, true], esc: [0, 720, true], buf: [0, 240, true], maxmb: [1, 1024, true], qvalid: [1, 3650, true],
  moMax: [1, 50, true], moSess: [1, 1440, true],
}
const PCT = new Set(['tds', 'dKAM', 'dMGR', 'dSH', 'emdp', 'pbg'])
const TEXT_RULE: Record<string, Partial<FieldSpec>> = {
  gstin: { rule: 'gstin' }, bgst: { rule: 'gstin' }, pan: { rule: 'pan' }, pin: { rule: 'pincode' }, phone: { rule: 'mobile' },
  web: { rule: 'url' }, ssoUrl: { rule: 'url' }, mail: { rule: 'email' }, reply: { rule: 'email' }, bmail: { rule: 'email' },
  legal: { rule: 'name', min: 2, max: 200 }, trade: { rule: 'name', min: 2, max: 200 }, bname: { rule: 'name', min: 2, max: 200 },
  city: { rule: 'name', min: 2, max: 100 }, sender: { rule: 'name', min: 2, max: 100 }, from: { rule: 'name', min: 2, max: 100 },
}
const CIN_RE = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/
function fieldSpec(f: Field): FieldSpec | undefined {
  if (f.t === 'number') {
    if (PCT.has(f.k)) return { label: f.l, rule: 'percent' }
    const [min, max, whole] = NUM[f.k] || [0, 1e12, false]
    return whole ? { label: f.l, rule: 'integer', min, max } : { label: f.l, rule: 'amount', min, max }
  }
  if (f.t === 'text') return { label: f.l, rule: 'text', max: 2000, ...TEXT_RULE[f.k] }
  if (f.t === 'textarea') return { label: f.l, rule: 'textarea', max: 2000 }
  return undefined
}
function settingError(f: Field, raw: string): string {
  const sp = fieldSpec(f)
  const v = f.t === 'number' && raw.trim() === '' ? '0' : raw   // an emptied number saves as 0 (existing behaviour) – check that
  if (!sp) return ''
  if (f.t === 'number' && v.trim() !== '' && !/^\d*\.?\d+$/.test(v.trim())) return Number(v) < 0 ? `${f.l} cannot be negative.` : `${f.l} must be a valid number.`
  const m = validate(v, sp)
  if (m) return m
  if (f.k === 'cin' && v.trim() && !CIN_RE.test(v.trim().toUpperCase())) return 'Enter a valid 21-character CIN (e.g. U72900KA2015PTC123456).'
  if (f.k === 'hsn' && v.trim() && !/^\d{4,8}$/.test(v.trim())) return 'HSN / SAC must be 4 to 8 digits.'
  return ''
}

/** prototype sw(): the 30×16 switch */
const Sw = ({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) => (
  <label className="sw"><input type="checkbox" checked={on} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.checked)} /><i /></label>
)

/** prototype setField(): one .setrow for a schema field. Text-like inputs save on blur / Enter; everything else on change. */
function SetField({ cat, f, value, canEdit, onSave, onUpload }: {
  cat: Category; f: Field; value: unknown; canEdit: boolean
  onSave: (cat: string, key: string, v: unknown) => Promise<boolean>; onUpload: (key: 'logo' | 'fav', file: File) => void
}) {
  const [draft, setDraft] = useState(str(value))
  const [listAdd, setListAdd] = useState('')
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { setDraft(str(value)); setErr('') }, [value])
  const dis = !canEdit
  const errId = `set-${cat.id}-${f.k}`
  const edit = (v: string) => { setDraft(v); setErr(settingError(f, v)) }
  const commit = () => {
    if (draft === str(value)) { setErr(''); return }
    const m = settingError(f, draft)
    setErr(m)
    if (m) return   // invalid: keep what was typed, do not save
    onSave(cat.id, f.k, f.t === 'number' ? (draft === '' ? 0 : Number(draft)) : draft).then(ok => { if (!ok) setDraft(str(value)) })
  }
  const errProps = { id: errId, 'aria-invalid': err ? true : undefined, 'aria-describedby': err ? `${errId}-err` : undefined }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' && f.t !== 'textarea') (e.target as HTMLElement).blur() }
  let el: ReactNode
  if (f.t === 'switch') el = <Sw on={!!value} disabled={dis} label={f.l} onChange={v => onSave(cat.id, f.k, v)} />
  else if (f.t === 'select') {
    const opts = f.o || []
    const cur = str(value)
    return <div className="setrow"><div className="setl"><b>{f.l}</b>{f.h && <small>{f.h}</small>}</div><div className="setc">
      <select className="in" value={cur} disabled={dis} aria-label={f.l} onChange={e => onSave(cat.id, f.k, e.target.value)}>
        {cur && !opts.includes(cur) && <option value={cur}>{cur}</option>}
        {opts.map(o => <option key={o} value={o}>{o}</option>)}
      </select></div></div>
  }
  else if (f.t === 'textarea') el = <><textarea className={`in ${err ? 'err' : ''}`} rows={3} value={draft} disabled={dis} aria-label={f.l} {...errProps} onChange={e => edit(e.target.value)} onBlur={commit} /><FieldError id={errId} msg={err} /></>
  else if (f.t === 'color') el = <div className="row" style={{ gap: 8 }}>
    <input type="color" value={/^#[0-9a-f]{6}$/i.test(str(value)) ? str(value) : '#0F6E8C'} disabled={dis} aria-label={f.l} onChange={e => onSave(cat.id, f.k, e.target.value.toUpperCase())} />
    <code>{str(value)}</code></div>
  else if (f.t === 'file') el = <div className="row" style={{ gap: 8 }}>
    <span className="chip"><Ic n="doc" /> {str(value) || 'No file'}</span>
    {canEdit && <><button type="button" className="btn s" onClick={() => fileRef.current?.click()}>Replace</button>
      <input ref={fileRef} type="file" accept="image/*,.ico" hidden onChange={e => { const file = e.target.files?.[0]; if (file) onUpload(f.k === 'logo' ? 'logo' : 'fav', file); e.target.value = '' }} /></>}
  </div>
  else if (f.t === 'chips') {
    const cur = str(value).split(',').filter(Boolean)
    el = <div className="row wrap" style={{ gap: 5 }}>{(f.o || []).map(o => {
      const on = cur.includes(o)
      const toggle = () => { if (dis) return; const nx = on ? cur.filter(x => x !== o) : [...cur, o]; onSave(cat.id, f.k, (f.o || []).filter(x => nx.includes(x)).join(',')) }
      return <span key={o} role="button" tabIndex={dis ? -1 : 0} aria-pressed={on} className={`chip ${on ? 'on' : ''}`} onClick={toggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}>{o}</span>
    })}</div>
  }
  else if (f.t === 'list') {
    const L = Array.isArray(value) ? (value as string[]) : (Array.isArray(f.d) ? (f.d as string[]) : [])
    const add = () => { const v = listAdd.trim(); if (!v) return; onSave(cat.id, f.k, [...L, v]).then(ok => { if (ok) setListAdd('') }) }
    el = <div className="list bx">
      {L.map((x, i) => <div key={`${x}-${i}`}><span className="fl">{x}</span>
        {canEdit && <button type="button" className="btn s g" aria-label={`Remove ${x}`} onClick={() => onSave(cat.id, f.k, L.filter((_, j) => j !== i))}><Ic n="x" /></button>}</div>)}
      {canEdit && <div className="add"><input className="in sm" placeholder="e.g. 15 Dec – Company event" value={listAdd} onChange={e => setListAdd(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }} /><button type="button" className="btn s p" onClick={add}>Add</button></div>}
    </div>
  }
  else el = <><input className={`in ${err ? 'err' : ''}`} type={f.t === 'number' ? 'number' : f.t === 'time' ? 'time' : 'text'} value={draft} disabled={dis} aria-label={f.l} {...errProps}
    onChange={e => edit(e.target.value)} onBlur={commit} onKeyDown={onKey} /><FieldError id={errId} msg={err} /></>
  return <div className={`setrow ${f.t === 'switch' ? 'tgl' : ''}`}><div className="setl"><b>{f.l}</b>{f.h && <small>{f.h}</small>}</div><div className="setc">{el}</div></div>
}

export default function AppSettingsPage() {
  const [sp, setSp] = useSearchParams()
  const { success, error, info } = useToast()
  const [data, setData] = useState<Payload | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [q, setQ] = useState('')
  const [catId, setCatId] = useState<string>(() => sp.get('c') || store.get('settings:cat', 'company'))
  const [hist, setHist] = useState<{ items: Change[]; total: number } | null>(null)
  const [billing, setBilling] = useState<Billing | null>(null)
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; ok: string; danger?: boolean; fn: () => void } | null>(null)
  const [saving, setSaving] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLDivElement>(null)

  useEffect(() => { appSettingsApi.load().then(setData).catch(e => setLoadErr(errMsg(e, 'Could not load Settings'))) }, [])
  useEffect(() => { store.set('settings:cat', catId); setSp(s => { const n = new URLSearchParams(s); n.set('c', catId); return n }, { replace: true }) }, [catId, setSp])
  // persisted appearance takes effect on load (prototype setApply on paint)
  useEffect(() => { if (!data) return; const b = data.values.branding || {}; (['theme', 'dens', 'anim', 'sidebar'] as const).forEach(k => applyAppearance(k, b[k])) }, [data])

  const cats = data?.categories || []
  const cat = cats.find(c => c.id === catId) || cats[0]
  const canEdit = !!data?.can_manage
  const qq = q.trim().toLowerCase()

  useEffect(() => {
    if (!data || !cat) return
    if (cat.history && !hist) appSettingsApi.history(0, 40).then(setHist).catch(e => error(errMsg(e, 'Could not load change history')))
    if (cat.billing && !billing) appSettingsApi.billing().then(setBilling).catch(e => error(errMsg(e, 'Could not load billing')))
    if (cat.devices && !devices) appSettingsApi.devices().then(setDevices).catch(e => error(errMsg(e, 'Could not load devices')))
  }, [data, cat, hist, billing, devices, error])

  const pushChange = (c: Change) => setHist(h => (h ? { items: [c, ...h.items].slice(0, 100), total: h.total + 1 } : h))

  const save = useCallback(async (c: string, k: string, v: unknown): Promise<boolean> => {
    if (!canEdit) { error('You don’t have permission to change settings'); return false }
    setSaving(n => n + 1)
    try {
      const out = await appSettingsApi.save(c, k, v)
      setData(d => d ? { ...d, values: { ...d.values, [c]: { ...d.values[c], [k]: out.value } }, customised: { ...d.customised, [c]: Array.from(new Set([...(d.customised[c] || []), k])) } } : d)
      pushChange(out.change)
      if (c === 'branding') applyAppearance(k, out.value)
      success(`Saved · ${out.label}`)
      return true
    } catch (e) { error(errMsg(e, 'Could not save')); return false }
    finally { setSaving(n => n - 1) }
  }, [canEdit, error, success])

  const upload = async (kind: 'logo' | 'fav', file: File) => {
    setSaving(n => n + 1)
    try {
      const out = await appSettingsApi.upload(kind, file)
      setData(d => d ? { ...d, values: { ...d.values, branding: { ...d.values.branding, [kind]: out.value } } } : d)
      pushChange(out.change)
      success('File uploaded')
    } catch (e) { error(errMsg(e, 'Upload failed')) }
    finally { setSaving(n => n - 1) }
  }

  const resetSection = (c: Category) => setConfirm({
    title: 'Reset to defaults', body: 'Reset every setting in this section to its default value?', ok: 'Reset', danger: true,
    fn: async () => {
      setConfirm(null)
      try { await appSettingsApi.reset(c.id); const fresh = await appSettingsApi.load(); setData(fresh); setHist(null); success('Section reset') }
      catch (e) { error(errMsg(e, 'Could not reset')) }
    },
  })

  const goCat = (id: string) => { setCatId(id); setQ(''); mainRef.current?.closest('main')?.scrollTo?.(0, 0); window.scrollTo(0, 0) }

  // search – prototype: label + category name + group name
  const results = useMemo(() => !qq || !data ? [] : cats.flatMap(c => c.g.flatMap(([gn, fs]) => fs.filter(f => `${f.l} ${c.n} ${gn}`.toLowerCase().includes(qq)).map(f => ({ c, f, gn })))), [qq, data, cats])

  if (loadErr) return <div className="bwi"><div className="note bad">{loadErr}</div></div>
  if (!data || !cat) return <div className="bwi"><div className="empty">Loading settings…</div></div>
  const vals = data.values[cat.id] || {}

  let body: ReactNode
  if (qq) {
    body = <div className="panel"><div className="ph">{results.length} result{results.length === 1 ? '' : 's'} for “{q.trim()}”</div><div className="pb z">
      {results.length ? results.map(r => <div key={`${r.c.id}.${r.f.k}`} className="srow">
        <SetField cat={r.c} f={r.f} value={(data.values[r.c.id] || {})[r.f.k]} canEdit={canEdit} onSave={save} onUpload={upload} />
        <div className="srt"><a role="link" tabIndex={0} onClick={() => goCat(r.c.id)} onKeyDown={e => { if (e.key === 'Enter') goCat(r.c.id) }}>{r.c.n}</a> · {r.gn}</div>
      </div>) : <div className="empty">No setting matches. Try “password”, “currency” or “backup”.</div>}
    </div></div>
  } else {
    const head = <div className="setH"><span className="fsi"><Ic n={cat.i} size={18} /></span><div className="fl"><h2>{cat.n}</h2><div className="mu">{cat.d}</div></div>
      {canEdit && !cat.history && <button type="button" className="btn s" onClick={() => resetSection(cat)}>Reset to defaults</button>}</div>
    const groups = cat.g.map(([gn, fs]) => <div key={gn} className="panel mb"><div className="ph">{gn}</div><div className="pb z">
      {fs.map(f => <SetField key={f.k} cat={cat} f={f} value={vals[f.k]} canEdit={canEdit} onSave={save} onUpload={upload} />)}</div></div>)
    const matrix = cat.matrix && (() => {
      const M = (vals.matrix as Matrix) || []
      const { events, channels } = data.matrix
      return <div className="panel mb"><div className="ph">Who is notified, and how</div><div className="pb z"><div className="tw fit"><table className="t">
        <thead><tr><th>Event</th>{channels.map(c => <th key={c} className="c">{c}</th>)}</tr></thead>
        <tbody>{events.map((e, i) => <tr key={e}><td>{e}</td>{channels.map((c, j) => <td key={c} className="c">
          <Sw on={!!M[i]?.[j]} disabled={!canEdit} label={`${e} · ${c}`} onChange={v => { const nx = M.map(r => [...r]); nx[i][j] = v; save('notify', 'matrix', nx) }} /></td>)}</tr>)}</tbody>
      </table></div></div></div>
    })()
    const series = cat.series && <SeriesTable rows={(vals.series as SeriesRow[]) || []} canEdit={canEdit} onSave={rows => save('number', 'series', rows)} />
    const bill = cat.billing && <BillingBlock b={billing} seatsNote={data.tenant.name} info={info} />
    const dev = cat.devices && <Panel title="Registered mobile devices" z className="mt">
      {devices === null ? <div className="empty">Loading…</div> : <Tbl<Device> cols={[
        { k: 'who', t: 'User', fn: r => <span className="row" style={{ gap: 6 }}><Av name={r.who} />{r.who}</span> },
        { k: 'model', t: 'Device' }, { k: 'ip', t: 'IP' }, { k: 'last', t: 'Last seen', fn: r => fdt(r.last) },
        { k: 'x', t: '', fn: r => canEdit ? <button type="button" className="btn s d" onClick={() => setConfirm({
          title: 'Revoke device', body: `Sign out ${r.who}’s device “${r.model}”? App data is wiped on its next connect.`, ok: 'Revoke', danger: true,
          fn: async () => { setConfirm(null); try { await appSettingsApi.revoke(r.id); setDevices(d => (d || []).filter(x => x.id !== r.id)); success('Device revoked – app data wiped on next connect') } catch (e) { error(errMsg(e, 'Could not revoke')) } },
        })}>Revoke</button> : null },
      ]} rows={devices} empty="No active devices" />}
    </Panel>
    const history = cat.history && <Panel title="Recent changes" z>
      {hist === null ? <div className="empty">Loading…</div> : <>
        <Tbl<Change> cols={[
          { k: 't', t: 'When', fn: r => fdt(r.t) }, { k: 'u', t: 'Who', fn: r => <span className="row" style={{ gap: 6 }}><Av name={r.u} />{r.u}</span> },
          { k: 's', t: 'Section' }, { k: 'c', t: 'Setting' }, { k: 'o', t: 'From', fn: r => <span className="mu">{r.o}</span> }, { k: 'n', t: 'To', fn: r => <b>{r.n}</b> },
        ]} rows={hist.items} empty="No changes yet" />
        {hist.items.length < hist.total && <div className="row" style={{ padding: 8, justifyContent: 'center' }}>
          <button type="button" className="btn s" onClick={() => appSettingsApi.history(hist.items.length, 40).then(r => setHist({ items: [...hist.items, ...r.items], total: r.total })).catch(e => error(errMsg(e)))}>Load more · {hist.total - hist.items.length} older</button></div>}
      </>}
    </Panel>
    body = <>{bill}{head}{history}{series}{groups}{matrix}{dev}</>
  }

  return (
    <div className="bwi" ref={mainRef}>
      <div className="pg">
        <div><div className="crumb">Administration</div><h1>Settings</h1></div>
        <span className="cnt">Application settings for {data.tenant.name}</span>
        {saving > 0 && <span className="saving">Saving…</span>}
        <span className="fl" />
        <div className="sr2"><Ic n="search" /><input ref={searchRef} className="in" placeholder="Search all settings…" value={q} aria-label="Search all settings" onChange={e => setQ(e.target.value)} /></div>
      </div>
      <div className="split setsp">
        <div className="panel"><div className="side setnav" role="tablist" aria-label="Settings sections">
          {cats.map(c => <div key={c.id} role="tab" tabIndex={0} aria-selected={!qq && c.id === cat.id} className={!qq && c.id === cat.id ? 'on' : ''} onClick={() => goCat(c.id)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goCat(c.id) } }}>
            <span className="fsi s"><Ic n={c.i} /></span><span className="fl"><b>{c.n}</b><small className="mu" title={c.d}>{c.d.length > 44 ? c.d.slice(0, 42) + '…' : c.d}</small></span>
          </div>)}
        </div></div>
        <div>{body}</div>
      </div>
      {confirm && <Modal title={confirm.title} width={420} onClose={() => setConfirm(null)}
        foot={<><button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button><button type="button" className={`btn ${confirm.danger ? 'd' : 'p'}`} onClick={confirm.fn}>{confirm.ok}</button></>}>
        <p style={{ margin: 0 }}>{confirm.body}</p>
      </Modal>}
    </div>
  )
}

/** prototype "Number series" table – prefix, suffix, digits, next number, restart yearly, preview. Saves the whole series on change. */
function SeriesTable({ rows, canEdit, onSave }: { rows: SeriesRow[]; canEdit: boolean; onSave: (rows: SeriesRow[]) => Promise<boolean> }) {
  const [draft, setDraft] = useState<SeriesRow[]>(rows)
  useEffect(() => { setDraft(rows) }, [rows])
  // raw text of the number cells, so "abc" / "-1" / "" can be explained instead of silently becoming 0
  const [raw, setRaw] = useState<Record<string, string>>({})
  useEffect(() => { setRaw({}) }, [rows])
  const cellErr = (r: SeriesRow, i: number, k: 'p' | 's' | 'd' | 'n'): string => {
    if (k === 'p' || k === 's') return r[k].length > 20 ? `${k === 'p' ? 'Prefix' : 'Suffix'} cannot exceed 20 characters.` : ''
    const v = raw[`${i}.${k}`] ?? String(r[k])
    return k === 'd' ? validate(v, { label: 'Digits', rule: 'integer', required: true, min: 1, max: 12 })
      : validate(v, { label: 'Next number', rule: 'integer', required: true, min: 0, max: 999_999_999_999 })
  }
  const errs: Record<string, string> = {}
  draft.forEach((r, i) => (['p', 's', 'd', 'n'] as const).forEach(k => { const m = cellErr(r, i, k); if (m) errs[`${i}.${k}`] = m }))
  const upd = (i: number, patch: Partial<SeriesRow>) => setDraft(d => d.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const updNum = (i: number, k: 'd' | 'n', v: string) => { setRaw(x => ({ ...x, [`${i}.${k}`]: v })); upd(i, { [k]: Number(v) } as Partial<SeriesRow>) }
  const commit = () => {
    if (Object.keys(errs).length) return   // invalid cell: keep the draft, show the message, save nothing
    if (JSON.stringify(draft) !== JSON.stringify(rows)) onSave(draft).then(ok => { if (!ok) setDraft(rows) })
  }
  const cell = (i: number, k: string) => ({ cls: errs[`${i}.${k}`] ? 'err' : '', id: `ser-${i}-${k}`, msg: errs[`${i}.${k}`] })
  const preview = (r: SeriesRow) => `${r.p}${String(r.n || 0).padStart(Math.max(1, Number(r.d) || 1), '0')}${r.s}`
  return <div className="panel mb"><div className="ph">Number series <small className="mu">– prefix, suffix and padding for every record type</small></div><div className="pb z"><div className="tw fit">
    <table className="t"><thead><tr><th>Record</th><th>Prefix</th><th>Suffix</th><th>Digits</th><th>Next number</th><th>Restart every year</th><th>Preview</th></tr></thead>
      <tbody>{draft.map((r, i) => <tr key={r.r}>
        <td><b>{r.r}</b></td>
        <td><input id={cell(i, 'p').id} className={`in sm ${cell(i, 'p').cls}`} style={{ width: 80 }} value={r.p} disabled={!canEdit} aria-label={`${r.r} prefix`} aria-invalid={cell(i, 'p').msg ? true : undefined} onChange={e => upd(i, { p: e.target.value })} onBlur={commit} /><FieldError id={cell(i, 'p').id} msg={cell(i, 'p').msg} /></td>
        <td><input id={cell(i, 's').id} className={`in sm ${cell(i, 's').cls}`} style={{ width: 80 }} value={r.s} disabled={!canEdit} aria-label={`${r.r} suffix`} aria-invalid={cell(i, 's').msg ? true : undefined} onChange={e => upd(i, { s: e.target.value })} onBlur={commit} /><FieldError id={cell(i, 's').id} msg={cell(i, 's').msg} /></td>
        <td><input id={cell(i, 'd').id} className={`in sm ${cell(i, 'd').cls}`} type="number" min={1} max={12} style={{ width: 64 }} value={raw[`${i}.d`] ?? r.d} disabled={!canEdit} aria-label={`${r.r} digits`} aria-invalid={cell(i, 'd').msg ? true : undefined} onChange={e => updNum(i, 'd', e.target.value)} onBlur={commit} /><FieldError id={cell(i, 'd').id} msg={cell(i, 'd').msg} /></td>
        <td><input id={cell(i, 'n').id} className={`in sm ${cell(i, 'n').cls}`} type="number" min={0} style={{ width: 90 }} value={raw[`${i}.n`] ?? r.n} disabled={!canEdit} aria-label={`${r.r} next number`} aria-invalid={cell(i, 'n').msg ? true : undefined} onChange={e => updNum(i, 'n', e.target.value)} onBlur={commit} /><FieldError id={cell(i, 'n').id} msg={cell(i, 'n').msg} /></td>
        <td><Sw on={!!r.y} disabled={!canEdit} label={`${r.r} restart every year`} onChange={v => { const nx = draft.map((x, j) => (j === i ? { ...x, y: v } : x)); setDraft(nx); if (!Object.keys(errs).length) onSave(nx) }} /></td>
        <td><code>{preview(r)}</code></td>
      </tr>)}</tbody></table></div></div></div>
}

/** prototype Plan & billing: Plan · Seats · Payment method cards, Usage this month, Invoices. */
function BillingBlock({ b, seatsNote, info }: { b: Billing | null; seatsNote: string; info: (t: string, m?: string) => void }) {
  if (!b) return <div className="panel mb"><div className="pb"><div className="empty">Loading plan & billing…</div></div></div>
  const seatsPct = pct(b.seats.used, b.seats.total)
  return <>
    <div className="g g3 mb">
      <Panel title="Plan"><div className="bigv">{b.plan?.name || 'Trial'}</div>
        <div className="mu">{b.plan?.renews ? `Renews ${fd(b.plan.renews)} · ${b.plan.cycle}` : (b.plan?.status || '—')}</div>
        <div className="mt"><button type="button" className="btn s" onClick={() => info('Plan change request sent to your account manager')}>Change plan</button></div></Panel>
      <Panel title="Seats"><div className="bigv">{b.seats.used} <small className="mu">of {b.seats.total || '∞'}</small></div>
        <div className="pm mt"><i style={{ width: `${seatsPct}%`, background: seatsPct >= 90 ? 'var(--bw-ba)' : 'var(--bw-ac)' }} /></div>
        <div className="mt"><button type="button" className="btn s" onClick={() => info('Request for extra seats sent', seatsNote)}>Add seats</button></div></Panel>
      <Panel title="Payment method">
        {b.payment ? <><div className="b">{b.payment.method}{b.payment.ref ? ` ·· ${b.payment.ref.slice(-4)}` : ''}</div><div className="mu">Last paid {fd(b.payment.on)}</div></>
          : <><div className="b">No payment method on file</div><div className="mu">Invoices are settled by bank transfer</div></>}
        <div className="mt"><button type="button" className="btn s" onClick={() => info('Payment method update link emailed')}>Update</button></div></Panel>
    </div>
    <div className="g g2 mb">
      <Panel title="Usage this month">{b.usage.map(u => <div key={u.n} className="mb"><div className="row"><span className="fl">{u.n}</span><small className="mu">{u.u}{u.x} of {u.m || '∞'}{u.x}</small></div>
        <div className="pm"><i style={{ width: `${pct(u.u, u.m)}%`, background: pct(u.u, u.m) >= 90 ? 'var(--bw-ba)' : 'var(--bw-ac)' }} /></div></div>)}</Panel>
      <Panel title="Invoices" z><Tbl<Billing['invoices'][number]> cols={[
        { k: 'n', t: 'Invoice' }, { k: 'p', t: 'Period' }, { k: 'a', t: 'Amount', r: true, fn: r => inr(r.a) }, { k: 's', t: 'Status', fn: r => <Pill s={r.s} t={r.s === 'Paid' ? 'ok' : r.s === 'Overdue' || r.s === 'Failed' ? 'ba' : 'wa'} /> },
        { k: 'x', t: '', fn: r => r.link ? <a href={r.link} target="_blank" rel="noreferrer">Pay</a> : null },
      ]} rows={b.invoices} empty="No invoices yet" /></Panel>
    </div>
  </>
}
