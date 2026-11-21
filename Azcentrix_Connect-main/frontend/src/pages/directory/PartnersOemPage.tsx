// Partners & OEM – prototype v17 listPage('oem'): crumb (company) · "Partners & OEM" · N records · + New partner,
// views All · Auth expiring ≤ 60d (with counts), category filter, grid OEM | Category | Contact | Authorisation valid | Discount | Rating | Tenders | Status,
// bulk Delete, inline edit (discount / status), and the record drawer (openRec): Overview · Authorisation · Activity · Documents · Notes with Edit / Delete.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Pill, Tbl } from '@/pages/customers/kit'
import { directoryApi, dto, errMsg, fd, inr, type ListQuery, type OemDetail, type OemIn, type OemMeta, type OemRow } from './directoryApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './directory.css'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, mapApiErrors, vPercent, vText, type FieldSpec, type Val } from '@/utils/validation'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}
const stars = (n: number) => '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(5 - Math.max(0, Math.min(5, n)))
const tone = (s: string) => (s === 'Active' ? 'ok' : s === 'On hold' ? 'wa' : 'mu')

export default function PartnersOemPage() {
  const [sp, setSp] = useSearchParams()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<OemMeta | null>(null)
  const [view, setView] = useState<string>(() => store.get('oem:view', 'All'))
  const [category, setCategory] = useState('')
  const [p, setP] = useState<Omit<ListQuery, 'view' | 'category' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: OemRow[]; total: number; total_all: number; counts: Record<string, number>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [form, setForm] = useState<{ row?: OemRow } | null>(null)
  const [del, setDel] = useState<OemRow[] | null>(null)
  const open = Number(sp.get('open') || 0) || null
  const setOpen = (id: number | null) => setSp(s => { const n = new URLSearchParams(s); if (id) n.set('open', String(id)); else n.delete('open'); return n })

  useEffect(() => { directoryApi.oemMeta().then(m => { setMeta(m); setView(v => m.views.includes(v) ? v : 'All') }).catch(e => error(errMsg(e, 'Could not load Partners & OEM'))) }, [error])
  useEffect(() => { store.set('oem:view', view) }, [view])
  const key = JSON.stringify([view, category, p, qf, rev])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => {
      directoryApi.oems({ view, category, q: qf.q, f: qf.f, ...p }).then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, loading: false })); error(errMsg(e, 'Could not load partners')) } })
    }, 120)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const changed = useCallback(() => setRev(r => r + 1), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListQuery['adv'] }) => setP({ offset: s.offset, limit: s.limit, sorts: s.sorts, adv: s.adv }), [])
  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => { setQf(s); setP(x => ({ ...x, offset: 0 })) }, [])
  const can = meta?.can
  const save = async (r: OemRow, d: OemIn, msg: string) => { try { await directoryApi.updateOem(r.id, d); changed(); success(msg) } catch (e) { const fx = apiFieldErrors(e); error(Object.values(fx)[0] || errMsg(e)) } }

  const cols = useMemo<GridCol<OemRow>[]>(() => [
    { k: 'name', t: 'OEM', w: 220, fn: r => <a className="rec" onClick={e => { e.stopPropagation(); setOpen(r.id) }}><b>{r.name}</b></a>, txt: r => r.name },
    { k: 'category', t: 'Category', w: 130 },
    { k: 'contact', t: 'Contact', w: 150 },
    { k: 'auth', t: 'Authorisation valid', w: 150, date: true, fn: r => { const n = dto(r.auth); return <span className={n != null && n < 0 ? 'tbad' : n != null && n <= 60 ? 'twarn' : ''}>{fd(r.auth)}</span> }, txt: r => r.auth || '' },
    { k: 'discount', t: 'Discount', w: 96, r: true, fn: r => (r.discount == null ? '—' : `${r.discount}%`), txt: r => (r.discount == null ? '' : `${r.discount}%`), sv: r => r.discount ?? 0,
      ...(can?.update ? { ed: { t: 'num' as const, min: 0, max: 100, step: 0.5, value: (r: OemRow) => String(r.discount ?? ''), save: (r: OemRow, v: string) => { const bad = vPercent(v, 'Discount %'); if (bad) { error(bad); return Promise.reject(new Error(bad)) } return save(r, { discount: v === '' ? null : Number(v) }, 'Discount saved') } } } : {}) },
    { k: 'rating', t: 'Rating', w: 100, fn: r => <span className="stars" title={`${r.rating}/5`}>{stars(r.rating)}</span>, txt: r => String(r.rating), sv: r => r.rating },
    { k: 'tenders', t: 'Tenders', w: 90, r: true, sum: true },
    { k: 'status', t: 'Status', w: 100, fn: r => <Pill s={r.status} t={tone(r.status)} />, txt: r => r.status,
      ...(can?.update && meta ? { ed: { t: 'sel' as const, o: meta.statuses, value: (r: OemRow) => r.status, save: (r: OemRow, v: string) => save(r, { status: v }, 'Status saved') } } : {}) },
  ], [can, meta])    // eslint-disable-line react-hooks/exhaustive-deps

  const menu = (r: OemRow): GridMenuItem[] => [
    { l: 'Open', i: <Ic n="eye" />, fn: () => setOpen(r.id) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => setForm({ row: r }) }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ]
  const bulk: [string, (rows: OemRow[]) => void][] = can?.delete ? [['Delete', rows => setDel(rows)]] : []
  const tools = <select className="in sm" style={{ width: 140 }} value={category} aria-label="Category" onChange={e => { setCategory(e.target.value); setP(x => ({ ...x, offset: 0 })) }}>
    <option value="">All</option>{(meta?.categories || []).map(c => <option key={c} value={c}>{c}</option>)}</select>

  return <div className="bwi">
    <div className="pg">
      <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Partners &amp; OEM</h1></div>
      <span className="cnt">{data.total_all} records</span>
      <span className="fl" />
      {can?.create && <button type="button" className="btn p" onClick={() => setForm({})}><Ic n="plus" /> New partner</button>}
    </div>
    <div className="row wrap mb" style={{ gap: 6 }}>
      {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => { setView(v); setP(x => ({ ...x, offset: 0 })) }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>{v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
    </div>
    <div className="panel" aria-busy={data.loading}>
      <BwGrid id="oem-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => setOpen(r.id)} bulk={bulk} tools={tools} menu={menu}
        server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No partners match the current filters.'} />
    </div>
    {form && meta && <OemForm meta={meta} row={form.row} onClose={() => setForm(null)} onSaved={id => { setForm(null); changed(); if (!form.row) setOpen(id) }} />}
    {del && <Modal title={del.length === 1 ? 'Delete partner' : 'Delete partners'} width={440} onClose={() => setDel(null)}
      foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={() => directoryApi.deleteOems(del.map(r => r.id)).then(r => { setDel(null); changed(); if (open && del.some(x => x.id === open)) setOpen(null); r.deleted ? success(`${r.deleted} deleted`) : warning('Nothing deleted') }).catch(e => error(errMsg(e)))}>Delete {del.length > 1 ? del.length : ''}</button></>}>
      <p style={{ margin: 0 }}>{del.length === 1 ? `Delete “${del[0].name}”? Tenders that reference it keep their history.` : `Delete ${del.length} partners? Tenders that reference them keep their history.`}</p></Modal>}
    {open && <OemDrawer id={open} onClose={() => setOpen(null)} onChanged={changed} onEdit={r => setForm({ row: r })} onDelete={r => setDel([r])} />}
  </div>
}

/* ───────────── New / edit partner (prototype FD.oem: name · category · contact · authorisation valid till · typical discount %) ───────────── */
// backend directory_router OemIn: name 2–200 (required here), contact ≤ 100, auth a valid date, discount 0–100, rating 0–5
const OEM_SPEC: Record<string, FieldSpec> = {
  name: { label: 'OEM name', rule: 'name', required: true, min: 2, max: 200 }, contact: { label: 'Contact', rule: 'text', max: 100 },
  auth: { label: 'Authorisation valid till', rule: 'date' }, discount: { label: 'Discount %', rule: 'percent' }, rating: { label: 'Rating', rule: 'integer', min: 0, max: 5 },
}
const OEM_ORDER = ['name', 'category', 'contact', 'auth', 'discount', 'rating', 'status']
const oemInv = (m?: string) => ({ 'aria-invalid': m ? true : undefined })
function OemForm({ meta, row, onClose, onSaved }: { meta: OemMeta; row?: OemRow; onClose: () => void; onSaved: (id: number) => void }) {
  const { success, error } = useToast()
  const [d, setD] = useState<OemIn>({ name: row?.name || '', category: row?.category || '', contact: row?.contact || '', auth: row?.auth ? row.auth.slice(0, 10) : '', discount: row?.discount ?? null, rating: row?.rating ?? 4, status: row?.status || 'Active' })
  // raw text of the discount box, so a half-typed / out-of-range value can be reported instead of silently dropped
  const [disc, setDisc] = useState(row?.discount != null ? String(row.discount) : '')
  const [busy, setBusy] = useState(false)
  const fe = useFieldErrors(), errs = fe.errors
  const vals = (x = d, dc = disc): Record<string, Val> => ({ name: x.name, contact: x.contact, auth: x.auth, discount: dc, rating: x.rating })
  const jump = (bad: Record<string, string>) => { const k = OEM_ORDER.find(f => bad[f]); const el = k && document.getElementById(`oem-${k}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  const leave = (k: string) => fe.blur(k, vals()[k], OEM_SPEC[k])
  const submit = async () => {
    const bad = fe.validateAll(vals(), OEM_SPEC)
    if (Object.keys(bad).length) { jump(bad); return }
    setBusy(true)
    try {
      const body: OemIn = { ...d, name: (d.name || '').trim(), contact: (d.contact || '').trim(), auth: d.auth || null, discount: disc.trim() === '' ? null : Number(disc) }
      if (row) { await directoryApi.updateOem(row.id, body); success('Partner updated'); onSaved(row.id) }
      else { const r = await directoryApi.createOem(body); success(`Partner “${body.name}” created`); onSaved(r.id) }
    } catch (e) {
      const fx = Object.fromEntries(Object.entries(mapApiErrors(e)).filter(([k]) => OEM_ORDER.includes(k)))
      if (Object.keys(fx).length) { fe.setErrors(x => ({ ...x, ...fx })); jump(fx) }
      else error(errMsg(e))
    } finally { setBusy(false) }
  }
  return <Modal title={row ? `Edit · ${row.name}` : 'New partner'} width={560} onClose={onClose}
    foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={submit}>{row ? 'Save' : 'Create partner'}</button></>}>
    <div className="fg">
      <div className="f1"><label>OEM name *</label><input id="oem-name" className={`in ${errs.name ? 'err' : ''}`} {...oemInv(errs.name)} autoFocus value={d.name || ''} onChange={e => { setD({ ...d, name: e.target.value }); fe.change('name', e.target.value, OEM_SPEC.name) }} onBlur={() => leave('name')} /><FieldError id="oem-name" msg={errs.name} /></div>
      <div><label>Category</label><select className="in" value={d.category || ''} onChange={e => setD({ ...d, category: e.target.value })}><option value="">—</option>{meta.categories.map(c => <option key={c}>{c}</option>)}</select></div>
      <div><label>Contact</label><input id="oem-contact" className={`in ${errs.contact ? 'err' : ''}`} {...oemInv(errs.contact)} value={d.contact || ''} onChange={e => { setD({ ...d, contact: e.target.value }); fe.change('contact', e.target.value, OEM_SPEC.contact) }} onBlur={() => leave('contact')} /><FieldError id="oem-contact" msg={errs.contact} /></div>
      <div><label>Authorisation valid till</label><input id="oem-auth" className={`in ${errs.auth ? 'err' : ''}`} {...oemInv(errs.auth)} type="date" value={d.auth || ''} onChange={e => { setD({ ...d, auth: e.target.value }); fe.change('auth', e.target.value, OEM_SPEC.auth) }} onBlur={() => leave('auth')} /><FieldError id="oem-auth" msg={errs.auth} /></div>
      <div><label>Typical discount %</label><input id="oem-discount" className={`in ${errs.discount ? 'err' : ''}`} {...oemInv(errs.discount)} type="number" min={0} max={100} step={0.5} value={disc} onChange={e => { const x = e.target.value; setDisc(x); setD({ ...d, discount: x === '' ? null : Number(x) }); fe.change('discount', x, OEM_SPEC.discount) }} onBlur={() => leave('discount')} /><FieldError id="oem-discount" msg={errs.discount} /></div>
      <div><label>Rating</label><select id="oem-rating" className={`in ${errs.rating ? 'err' : ''}`} {...oemInv(errs.rating)} value={d.rating ?? 4} onChange={e => { setD({ ...d, rating: Number(e.target.value) }); fe.change('rating', e.target.value, OEM_SPEC.rating) }}>{[5, 4, 3, 2, 1].map(n => <option key={n} value={n}>{stars(n)}</option>)}</select><FieldError id="oem-rating" msg={errs.rating} /></div>
      <div><label>Status</label><select className="in" value={d.status || 'Active'} onChange={e => setD({ ...d, status: e.target.value })}>{meta.statuses.map(s => <option key={s}>{s}</option>)}</select></div>
    </div>
    {row && <p className="mu mt" style={{ fontSize: 12 }}>Contact details, authorisation number, credit limit and payment terms are on the <a href={`/oems/${row.id}/edit`} onClick={e => { e.preventDefault(); window.location.assign(`/oems/${row.id}/edit`) }}>full partner form</a>.</p>}
  </Modal>
}

/* ───────────── Record drawer (prototype openRec('oem')): Overview · Authorisation · Activity · Documents · Notes ───────────── */
const TABS = ['Overview', 'Authorisation', 'Activity', 'Documents', 'Notes'] as const
type Tab = typeof TABS[number]
function OemDrawer({ id, onClose, onChanged, onEdit, onDelete }: { id: number; onClose: () => void; onChanged: () => void; onEdit: (r: OemRow) => void; onDelete: (r: OemRow) => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [d, setD] = useState<OemDetail | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<Tab>('Overview')
  const [note, setNote] = useState('')
  const [noteErr, setNoteErr] = useState('')
  const noteCheck = (x: string) => (x.trim() ? vText(x, 'Notes', 0, 5000) : '')   // empty clears the notes
  const load = useCallback(() => { setErr(''); directoryApi.oem(id).then(r => { setD(r); setNote(r.notes) }).catch(e => { setD(null); setErr(errMsg(e, 'Could not open this partner')) }) }, [id])
  useEffect(() => { setD(null); setTab('Overview'); load() }, [load])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])
  const host = document.querySelector('.crm-shell') ?? document.body
  const kv = (rows: [string, ReactNode][]) => <div className="kv">{rows.map(([l, v]) => <div key={l}><span>{l}</span><span>{v}</span></div>)}</div>
  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw" role="dialog" aria-modal="true" aria-label={d?.name || 'Partner'}>
      <div className="dh">
        <div className="fl"><h2>{d?.name || (err ? 'Partner' : 'Loading…')}</h2>
          {d && <div className="sub"><span className="mono">OEM-{d.id}</span> · <Pill s={d.status} t={tone(d.status)} />{d.category && <span className="pill ac">{d.category}</span>}</div>}</div>
        {d && d.can.update && <button type="button" className="btn s" onClick={() => onEdit(d)}><Ic n="edit" /> Edit</button>}
        {d && d.can.delete && <button type="button" className="btn s d ib" title="Delete" aria-label="Delete partner" onClick={() => onDelete(d)}><Ic n="trash" /></button>}
        <button type="button" className="btn g ib" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
      </div>
      <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      <div className="db">
        {err ? <div className="dcard empty">{err} · <a onClick={load}>Retry</a></div> : !d ? <div className="empty">Loading…</div>
          : tab === 'Overview' ? <div className="dcard">{kv([['Name', d.name], ['Category', d.category || '—'], ['Contact', d.contact || '—'], ['Auth', fd(d.auth)], ['Discount', d.discount == null ? '—' : `${d.discount}%`],
            ['Rating', <span className="stars">{stars(d.rating)}</span>], ['Tenders', d.tenders], ['Status', d.status], ['Type', d.type], ['Email', d.contact_email || '—'], ['Phone', d.contact_phone || '—'],
            ['Account manager', d.account_manager || '—'], ['Payment terms', d.payment_terms || '—'], ['Support SLA', d.support_sla || '—'], ['Created', fd(d.created)]])}</div>
            : tab === 'Authorisation' ? <div className="dcard">{kv([['Authorisation valid till', fd(d.auth)], ['Status', <span className={d.auth_state === 'Renewal due' ? 'twarn' : ''}>{d.auth_state}</span>],
              ['Authorisation no.', d.auth_number || '—'], ['Typical discount', d.discount == null ? '—' : `${d.discount}%`], ['Tenders supported', d.tenders]])}
              <div className="note inf mt">Authorisation letters (MAF) are stored in Document Hub → OEM Authorisations.</div>
              {d.tender_list.length > 0 && <><h3 className="mt mb">Tenders supported</h3><Tbl rows={d.tender_list} cols={[{ k: 'title', t: 'Tender', fn: t => <a onClick={() => navigate(`/tenders?open=${t.id}`)}>{t.title}</a> }, { k: 'stage', t: 'Stage', fn: t => <Pill s={t.stage} t={t.stage === 'Won' ? 'ok' : t.stage === 'Lost' ? 'ba' : 'inf'} /> }, { k: 'value', t: 'Value', r: true, fn: t => inr(t.value) }]} /></>}</div>
              : tab === 'Activity' ? <div className="dcard">{d.activity.length ? <div className="tl">{d.activity.map((a, i) => <div key={i}><b>{a.t}</b><br /><small>{a.by} · {a.d ? fd(a.d) : ''}</small></div>)}</div>
                : <div className="tl"><div><b>Record created</b><br /><small>System · {fd(d.created)}</small></div></div>}</div>
                : tab === 'Documents' ? <div className="dcard"><div className="empty">No documents linked yet</div>
                  <button type="button" className="btn mt" onClick={() => navigate('/document-management')}><Ic n="up" /> Upload document</button></div>
                  : <div className="dcard"><div className="list bx">{d.notes ? d.notes.split('\n').filter(Boolean).map((n, i) => <div key={i}>{n}</div>) : <div className="mu">No notes yet</div>}</div>
                    <textarea id="oem-notes" className={`in mt ${noteErr ? 'err' : ''}`} aria-invalid={noteErr ? true : undefined} rows={3} placeholder="Add a note, @mention a teammate…" value={note} onChange={e => { setNote(e.target.value); setNoteErr(noteCheck(e.target.value)) }} onBlur={() => setNoteErr(noteCheck(note))} disabled={!d.can.update} /><FieldError id="oem-notes" msg={noteErr} />
                    {d.can.update && <button type="button" className="btn p mt" disabled={note === d.notes} onClick={() => { const bad = noteCheck(note); setNoteErr(bad); if (bad) { document.getElementById('oem-notes')?.focus(); return }
                      directoryApi.updateOem(d.id, { notes: note }).then(() => { success('Note saved'); load(); onChanged() }).catch(e => { const m = apiFieldErrors(e).notes; if (m) setNoteErr(m); else error(errMsg(e)) }) }}>Save notes</button>}</div>}
      </div>
    </aside>
  </div>, host)
}
