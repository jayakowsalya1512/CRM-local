// Competitive Intel – prototype v17 listPage('competitors'): crumb (company) · "Competitors" · N records · + New competitor,
// views All · Underbid us (with counts), grid Competitor | HQ | Met in bids | They won | We won | Their win % | Price vs us | Strength | Weakness,
// bulk Delete, inline edit (HQ / strength / weakness) and the record drawer (openRec): Overview · Head-to-head (strip + donut + SWOT) · Activity · Documents · Notes.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Donut, Pill, Strip, Tbl } from '@/pages/customers/kit'
import { directoryApi, errMsg, fd, inr, type CompDetail, type CompIn, type CompMeta, type CompRow, type ListQuery } from './directoryApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './directory.css'
import FieldError from '@/components/form/FieldError'
import { useFieldErrors } from '@/hooks/useFieldErrors'
import { apiFieldErrors, mapApiErrors, vText, type FieldSpec } from '@/utils/validation'

const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}
const delta = (v: number) => <span className={v < 0 ? 'tbad' : 'tok'}>{v > 0 ? '+' : ''}{v}%</span>

export default function CompetitorsIntelPage() {
  const [sp, setSp] = useSearchParams()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<CompMeta | null>(null)
  const [view, setView] = useState<string>(() => store.get('comp:view', 'All'))
  const [p, setP] = useState<Omit<ListQuery, 'view' | 'category' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: CompRow[]; total: number; total_all: number; counts: Record<string, number>; loading: boolean }>({ items: [], total: 0, total_all: 0, counts: {}, loading: true })
  const [rev, setRev] = useState(0)
  const [form, setForm] = useState<{ row?: CompRow } | null>(null)
  const [del, setDel] = useState<CompRow[] | null>(null)
  const open = Number(sp.get('open') || 0) || null
  const setOpen = (id: number | null) => setSp(s => { const n = new URLSearchParams(s); if (id) n.set('open', String(id)); else n.delete('open'); return n })

  useEffect(() => { directoryApi.compMeta().then(m => { setMeta(m); setView(v => m.views.includes(v) ? v : 'All') }).catch(e => error(errMsg(e, 'Could not load Competitive Intel'))) }, [error])
  useEffect(() => { store.set('comp:view', view) }, [view])
  const key = JSON.stringify([view, p, qf, rev])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => {
      directoryApi.comps({ view, q: qf.q, f: qf.f, ...p }).then(r => { if (live) setData({ ...r, loading: false }) })
        .catch(e => { if (live) { setData(d => ({ ...d, loading: false })); error(errMsg(e, 'Could not load competitors')) } })
    }, 120)
    return () => { live = false; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const changed = useCallback(() => setRev(r => r + 1), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListQuery['adv'] }) => setP({ offset: s.offset, limit: s.limit, sorts: s.sorts, adv: s.adv }), [])
  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => { setQf(s); setP(x => ({ ...x, offset: 0 })) }, [])
  const can = meta?.can
  const save = async (r: CompRow, d: CompIn, msg: string) => { try { await directoryApi.updateComp(r.id, d); changed(); success(msg) } catch (e) { const fx = apiFieldErrors(e); error(Object.values(fx)[0] || errMsg(e)) } }
  // inline cell edit: same length limits as the backend; an invalid value keeps the cell in edit mode
  const INLINE_MAX: Record<'hq' | 'strength' | 'weak', [string, number]> = { hq: ['Head office', 100], strength: ['Strength', 2000], weak: ['Weakness', 2000] }
  const ed = (k: 'hq' | 'strength' | 'weak', msg: string) => (can?.update ? { ed: { t: 'text' as const, value: (r: CompRow) => r[k], save: (r: CompRow, v: string) => {
    const bad = v.trim() ? vText(v, INLINE_MAX[k][0], 0, INLINE_MAX[k][1]) : ''
    if (bad) { error(bad); return Promise.reject(new Error(bad)) }
    return save(r, { [k]: v } as CompIn, msg) } } } : {})

  const cols = useMemo<GridCol<CompRow>[]>(() => [
    { k: 'name', t: 'Competitor', w: 220, fn: r => <a className="rec" onClick={e => { e.stopPropagation(); setOpen(r.id) }}><b>{r.name}</b></a>, txt: r => r.name },
    { k: 'hq', t: 'HQ', w: 130, ...ed('hq', 'Head office saved') },
    { k: 'met', t: 'Met in bids', w: 100, r: true, sum: true },
    { k: 'won', t: 'They won', w: 90, r: true, sum: true },
    { k: 'lost', t: 'We won', w: 90, r: true, sum: true },
    { k: 'wr', t: 'Their win %', w: 100, r: true, fn: r => `${r.wr}%`, txt: r => `${r.wr}%`, sv: r => r.wr },
    { k: 'delta', t: 'Price vs us', w: 100, r: true, fn: r => delta(r.delta), txt: r => `${r.delta > 0 ? '+' : ''}${r.delta}%`, sv: r => r.delta },
    { k: 'strength', t: 'Strength', w: 180, ...ed('strength', 'Strength saved') },
    { k: 'weak', t: 'Weakness', w: 180, ...ed('weak', 'Weakness saved') },
  ], [can])    // eslint-disable-line react-hooks/exhaustive-deps

  const menu = (r: CompRow): GridMenuItem[] => [
    { l: 'Open', i: <Ic n="eye" />, fn: () => setOpen(r.id) },
    ...(can?.update ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => setForm({ row: r }) }] : []),
    ...(can?.delete ? [{ l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel([r]) }] : []),
  ]
  const bulk: [string, (rows: CompRow[]) => void][] = can?.delete ? [['Delete', rows => setDel(rows)]] : []

  return <div className="bwi">
    <div className="pg">
      <div><div className="crumb">{meta?.company || 'Workspace'}</div><h1>Competitors</h1></div>
      <span className="cnt">{data.total_all} records</span>
      <span className="fl" />
      {can?.create && <button type="button" className="btn p" onClick={() => setForm({})}><Ic n="plus" /> New competitor</button>}
    </div>
    <div className="row wrap mb" style={{ gap: 6 }}>
      {(meta?.views || ['All']).map(v => <span key={v} role="button" tabIndex={0} className={`chip ${view === v ? 'on' : ''}`} onClick={() => { setView(v); setP(x => ({ ...x, offset: 0 })) }}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(v) } }}>{v} <small style={{ color: 'inherit', opacity: .7 }}>{data.counts[v] ?? ''}</small></span>)}
    </div>
    <div className="panel" aria-busy={data.loading}>
      <BwGrid id="competitors-v17" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => setOpen(r.id)} bulk={bulk} menu={menu}
        server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : 'No competitors match the current filters.'} />
    </div>
    {form && <CompForm row={form.row} onClose={() => setForm(null)} onSaved={id => { setForm(null); changed(); if (!form.row) setOpen(id) }} />}
    {del && <Modal title={del.length === 1 ? 'Delete competitor' : 'Delete competitors'} width={440} onClose={() => setDel(null)}
      foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
        <button type="button" className="btn d" onClick={() => directoryApi.deleteComps(del.map(r => r.id)).then(r => { setDel(null); changed(); if (open && del.some(x => x.id === open)) setOpen(null); r.deleted ? success(`${r.deleted} deleted`) : warning('Nothing deleted') }).catch(e => error(errMsg(e)))}>Delete {del.length > 1 ? del.length : ''}</button></>}>
      <p style={{ margin: 0 }}>{del.length === 1 ? `Delete “${del[0].name}”? Bid history that names it is kept.` : `Delete ${del.length} competitors? Bid history that names them is kept.`}</p></Modal>}
    {open && <CompDrawer id={open} onClose={() => setOpen(null)} onChanged={changed} onEdit={r => setForm({ row: r })} onDelete={r => setDel([r])} />}
  </div>
}

/* ───────────── New / edit competitor (prototype FD.competitors: name · head office · key strength · key weakness) ───────────── */
// backend directory_router CompIn: name 2–200 (required here), hq ≤ 100, strength / weak ≤ 2000, notes ≤ 5000
const COMP_SPEC: Record<string, FieldSpec> = {
  name: { label: 'Competitor name', rule: 'name', required: true, min: 2, max: 200 }, hq: { label: 'Head office', rule: 'text', max: 100 },
  strength: { label: 'Key strength', rule: 'text', max: 2000 }, weak: { label: 'Key weakness', rule: 'text', max: 2000 },
}
const COMP_ORDER = ['name', 'hq', 'strength', 'weak']
function CompForm({ row, onClose, onSaved }: { row?: CompRow; onClose: () => void; onSaved: (id: number) => void }) {
  const { success, error } = useToast()
  const [d, setD] = useState<CompIn>({ name: row?.name || '', hq: row?.hq || '', strength: row?.strength || '', weak: row?.weak || '' })
  const [busy, setBusy] = useState(false)
  const fe = useFieldErrors(), errs = fe.errors
  const jump = (bad: Record<string, string>) => { const k = COMP_ORDER.find(f => bad[f]); const el = k && document.getElementById(`cmp-${k}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }
  type K = 'name' | 'hq' | 'strength' | 'weak'
  const set = (k: K, x: string) => { setD({ ...d, [k]: x }); fe.change(k, x, COMP_SPEC[k]) }
  const leave = (k: K) => fe.blur(k, d[k], COMP_SPEC[k])
  const attrs = (k: K) => ({ id: `cmp-${k}`, className: `in ${errs[k] ? 'err' : ''}`, 'aria-invalid': errs[k] ? true : undefined, value: d[k] || '', onChange: (e: { target: { value: string } }) => set(k, e.target.value), onBlur: () => leave(k) })
  const submit = async () => {
    const bad = fe.validateAll({ name: d.name, hq: d.hq, strength: d.strength, weak: d.weak }, COMP_SPEC)
    if (Object.keys(bad).length) { jump(bad); return }
    setBusy(true)
    try {
      const body = { ...d, name: (d.name || '').trim(), hq: (d.hq || '').trim(), strength: (d.strength || '').trim(), weak: (d.weak || '').trim() }
      if (row) { await directoryApi.updateComp(row.id, body); success('Competitor updated'); onSaved(row.id) }
      else { const r = await directoryApi.createComp(body); success(`Competitor “${body.name}” created`); onSaved(r.id) }
    } catch (e) {
      const fx = Object.fromEntries(Object.entries(mapApiErrors(e)).filter(([k]) => COMP_ORDER.includes(k)))
      if (Object.keys(fx).length) { fe.setErrors(x => ({ ...x, ...fx })); jump(fx) }
      else error(errMsg(e))
    } finally { setBusy(false) }
  }
  return <Modal title={row ? `Edit · ${row.name}` : 'New competitor'} width={560} onClose={onClose}
    foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={submit}>{row ? 'Save' : 'Create competitor'}</button></>}>
    <div className="fg">
      <div className="f1"><label>Competitor *</label><input {...attrs('name')} autoFocus /><FieldError id="cmp-name" msg={errs.name} /></div>
      <div className="f1"><label>Head office</label><input {...attrs('hq')} /><FieldError id="cmp-hq" msg={errs.hq} /></div>
      <div><label>Key strength</label><input {...attrs('strength')} placeholder="e.g. Aggressive pricing" /><FieldError id="cmp-strength" msg={errs.strength} /></div>
      <div><label>Key weakness</label><input {...attrs('weak')} placeholder="e.g. Delivery delays" /><FieldError id="cmp-weak" msg={errs.weak} /></div>
    </div>
    {row && <p className="mu mt" style={{ fontSize: 12 }}>Registration, GST / PAN, directors, regions and departments are on the <a href={`/competitors/${row.id}/edit`} onClick={e => { e.preventDefault(); window.location.assign(`/competitors/${row.id}/edit`) }}>full competitor form</a>.</p>}
  </Modal>
}

/* ───────────── Record drawer (prototype openRec('competitors')): Overview · Head-to-head · Activity · Documents · Notes ───────────── */
const TABS = ['Overview', 'Head-to-head', 'Activity', 'Documents', 'Notes'] as const
type Tab = typeof TABS[number]
function CompDrawer({ id, onClose, onChanged, onEdit, onDelete }: { id: number; onClose: () => void; onChanged: () => void; onEdit: (r: CompRow) => void; onDelete: (r: CompRow) => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [d, setD] = useState<CompDetail | null>(null)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<Tab>('Overview')
  const [note, setNote] = useState('')
  const [noteErr, setNoteErr] = useState('')
  const noteCheck = (x: string) => (x.trim() ? vText(x, 'Notes', 0, 5000) : '')   // empty clears the notes
  const load = useCallback(() => { setErr(''); directoryApi.comp(id).then(r => { setD(r); setNote(r.notes) }).catch(e => { setD(null); setErr(errMsg(e, 'Could not open this competitor')) }) }, [id])
  useEffect(() => { setD(null); setTab('Overview'); load() }, [load])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])
  const host = document.querySelector('.crm-shell') ?? document.body
  const kv = (rows: [string, ReactNode][]) => <div className="kv">{rows.map(([l, v]) => <div key={l}><span>{l}</span><span>{v}</span></div>)}</div>
  return createPortal(<div className="bwi">
    <div className="bwi-dwo" onMouseDown={onClose} />
    <aside className="bwi-dw" role="dialog" aria-modal="true" aria-label={d?.name || 'Competitor'}>
      <div className="dh">
        <div className="fl"><h2>{d?.name || (err ? 'Competitor' : 'Loading…')}</h2>
          {d && <div className="sub"><span className="mono">CMP-{d.id}</span>{d.threat && <> · <Pill s={d.threat} t={/high/i.test(d.threat) ? 'ba' : /med/i.test(d.threat) ? 'wa' : 'mu'} /></>}</div>}</div>
        {d && d.can.update && <button type="button" className="btn s" onClick={() => onEdit(d)}><Ic n="edit" /> Edit</button>}
        {d && d.can.delete && <button type="button" className="btn s d ib" title="Delete" aria-label="Delete competitor" onClick={() => onDelete(d)}><Ic n="trash" /></button>}
        <button type="button" className="btn g ib" onClick={onClose} aria-label="Close"><Ic n="x" /></button>
      </div>
      <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      <div className="db">
        {err ? <div className="dcard empty">{err} · <a onClick={load}>Retry</a></div> : !d ? <div className="empty">Loading…</div>
          : tab === 'Overview' ? <div className="dcard">{kv([['Name', d.name], ['Hq', d.hq || '—'], ['Met', d.met], ['Won', d.won], ['Lost', d.lost], ['Delta', delta(d.delta)], ['Share', `${d.share}%`],
            ['Strength', d.strength || '—'], ['Weak', d.weak || '—'], ['Threat level', d.threat || '—'], ['Website', d.website || '—'], ['OEM partnerships', d.oem || '—'], ['Strong regions', d.regions || '—'], ['Created', fd(d.created)]])}</div>
            : tab === 'Head-to-head' ? <div className="dcard">
              <Strip items={[{ l: 'Bids met', v: d.met, f: 'int' }, { l: 'They won', v: d.won, f: 'int' }, { l: 'We won', v: d.lost, f: 'int' }, { l: 'Price vs ours', v: `${d.delta > 0 ? '+' : ''}${d.delta}%`, f: 'text', dc: d.delta < 0 ? 'tbad' : 'tok' }, { l: 'Market share', v: `${d.share}%`, f: 'text' }]} />
              <Donut d={[{ l: 'They won', v: d.won, c: 'var(--bw-ba)' }, { l: 'We won', v: d.lost, c: 'var(--bw-ok)' }]} c={`${Math.round(d.lost / Math.max(d.met, 1) * 100)}% ours`} />
              <h3 className="mt mb">SWOT notes</h3>{kv([['Strength', d.strength || '—'], ['Weakness', d.weak || '—'], ['Counter-strategy', 'Highlight delivery track record and local service']])}
              {d.encounters.length > 0 && <><h3 className="mt mb">Recent encounters</h3><Tbl rows={d.encounters} cols={[{ k: 'title', t: 'Tender', fn: t => <a onClick={() => navigate(`/tenders?open=${t.id}`)}>{t.title}</a> },
                { k: 'result', t: 'Result', fn: t => <Pill s={t.result || 'Pending'} t={t.result === 'Won' ? 'ok' : t.result === 'Lost' ? 'ba' : 'inf'} /> }, { k: 'l1', t: 'L1' }, { k: 'ours', t: 'Our bid', r: true, fn: t => inr(t.ours) }, { k: 'theirs', t: 'Their bid', r: true, fn: t => inr(t.theirs) }]} /></>}</div>
              : tab === 'Activity' ? <div className="dcard">{d.activity.length ? <div className="tl">{d.activity.map((a, i) => <div key={i}><b>{a.t}</b><br /><small>{a.by} · {a.d ? fd(a.d) : ''}</small></div>)}</div>
                : <div className="tl"><div><b>Record created</b><br /><small>System · {fd(d.created)}</small></div></div>}</div>
                : tab === 'Documents' ? <div className="dcard"><div className="empty">No documents linked yet</div>
                  <button type="button" className="btn mt" onClick={() => navigate('/document-management')}><Ic n="up" /> Upload document</button></div>
                  : <div className="dcard"><div className="list bx">{d.notes ? d.notes.split('\n').filter(Boolean).map((n, i) => <div key={i}>{n}</div>) : <div className="mu">No notes yet</div>}</div>
                    <textarea id="cmp-notes" className={`in mt ${noteErr ? 'err' : ''}`} aria-invalid={noteErr ? true : undefined} rows={3} placeholder="Add a note, @mention a teammate…" value={note} onChange={e => { setNote(e.target.value); setNoteErr(noteCheck(e.target.value)) }} onBlur={() => setNoteErr(noteCheck(note))} disabled={!d.can.update} /><FieldError id="cmp-notes" msg={noteErr} />
                    {d.can.update && <button type="button" className="btn p mt" disabled={note === d.notes} onClick={() => { const bad = noteCheck(note); setNoteErr(bad); if (bad) { document.getElementById('cmp-notes')?.focus(); return }
                      directoryApi.updateComp(d.id, { notes: note }).then(() => { success('Note saved'); load(); onChanged() }).catch(e => { const m = apiFieldErrors(e).notes; if (m) setNoteErr(m); else error(errMsg(e)) }) }}>Save notes</button>}</div>}
      </div>
    </aside>
  </div>, host)
}
