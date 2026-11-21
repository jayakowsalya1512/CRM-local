// Reports – prototype v17 R.reports: crumb "Intelligence" · "Reports" · N ready-made reports · + Build a report, then a panel
// with tabs Catalogue · Builder. Catalogue = split(category side list with counts – All · Favourites · Scheduled · categories –
// | "Search reports…" + list rows: title, category pill, schedule pill, ☆/★, Run). Run opens repView (ReportView.tsx).
// Builder = g12(Report builder: Data source · Columns · Group by · Save · Schedule | Live preview).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Pill } from '@/pages/customers/kit'
import ReportView, { ScheduleModal } from './ReportView'
import { errMsg, fd, inr, rpApi, type Catalogue, type Field, type Item, type Preview } from './reportsApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './reports.css'

const TABS = ['Catalogue', 'Builder'] as const
type Tab = typeof TABS[number]

export default function ReportsPage() {
  const [sp, setSp] = useSearchParams()
  const { error } = useToast()
  const [cat, setCat] = useState<Catalogue | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => { setErr(''); rpApi.catalogue().then(setCat).catch(e => { setErr(errMsg(e, 'Could not load reports')); error('Could not load reports', errMsg(e)) }) }, [error])
  useEffect(load, [load])
  const tab: Tab = sp.get('tab') === 'Builder' ? 'Builder' : 'Catalogue'
  const open = sp.get('r')
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); n.delete('r'); if (t === 'Catalogue') n.delete('tab'); else n.set('tab', t); return n })
  const run = (key: string) => setSp(s => { const n = new URLSearchParams(s); n.set('r', key); return n })
  const back = () => { setSp(s => { const n = new URLSearchParams(s); n.delete('r'); n.delete('p'); return n }); load() }

  if (open && cat) return <div className="bwi rpt"><ReportView key={open} rkey={open} cat={cat} onBack={back} onChanged={load} /></div>

  return <div className="bwi rpt">
    <div className="pg"><div><div className="crumb">Intelligence</div><h1>Reports</h1></div>
      <span className="cnt">{cat ? `${cat.ready_count} ready-made reports` : ''}</span><span className="fl" />
      {(!cat || cat.can.build) && <button type="button" className="btn p" onClick={() => setTab('Builder')}><Ic n="plus" /> Build a report</button>}</div>
    <div className="panel">
      <div className="tabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      <div className="pb">{err ? <div className="empty">{err} <button type="button" className="btn s" onClick={load}>Retry</button></div>
        : !cat ? <div className="empty">Loading…</div>
          : tab === 'Catalogue' ? <CatalogueTab cat={cat} setCat={setCat} onRun={run} />
            : cat.can.build ? <Builder cat={cat} onSaved={key => { load(); run(key) }} /> : <div className="empty">You don't have permission to build reports</div>}</div>
    </div>
  </div>
}

// ─── Catalogue ────────────────────────────────────────────────────────────────
function CatalogueTab({ cat, setCat, onRun }: { cat: Catalogue; setCat: (c: Catalogue) => void; onRun: (k: string) => void }) {
  const { error } = useToast()
  const [sel, setSel] = useState<string>(() => { try { return sessionStorage.getItem('rp-cat') || 'All' } catch { return 'All' } })
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => { try { sessionStorage.setItem('rp-cat', sel) } catch { /* private mode */ } }, [sel])
  const inCat = useCallback((it: Item, c: string) => c === 'All' || (c === 'Favourites' ? it.fav : c === 'Scheduled' ? !!it.schedule : it.cat === c), [])
  const cats = cat.categories
  useEffect(() => { if (!cats.includes(sel)) setSel('All') }, [cats, sel])
  const ql = q.trim().toLowerCase()
  const list = cat.items.filter(it => inCat(it, sel) && (!ql || `${it.n} ${it.d}`.toLowerCase().includes(ql)))
  const toggle = async (it: Item) => {
    if (busy) return
    setBusy(it.key)
    try { await rpApi.fav(it.key, !it.fav); setCat({ ...cat, items: cat.items.map(x => x.key === it.key ? { ...x, fav: !it.fav } : x) }) }
    catch (e) { error('Favourite not saved', errMsg(e)) } finally { setBusy(null) }
  }
  return <div className="split">
    <div className="side">{cats.map(c => <div key={c} role="button" tabIndex={0} className={c === sel ? 'on' : ''} onClick={() => setSel(c)}
      onKeyDown={e => { if (e.key === 'Enter') setSel(c) }}>{c}<span className="fl" /><small>{cat.items.filter(it => inCat(it, c)).length}</small></div>)}</div>
    <div>
      <input className="in mb" placeholder="Search reports…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search reports" />
      <div className="list rl">{list.length ? list.map(r => <div key={r.key}>
        <span className="fl"><b>{r.n}</b> <span className="pill mu">{r.cat}</span>{r.schedule && <> <span className="pill inf"><Ic n="clock" size={11} /> {r.schedule}</span></>}<br /><small>{r.d}</small></span>
        <button type="button" className="btn s g star" title={r.fav ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={r.fav} disabled={busy === r.key} onClick={() => toggle(r)}>{r.fav ? '★' : '☆'}</button>
        <button type="button" className="btn s p" onClick={() => onRun(r.key)}>Run</button>
      </div>) : <div className="empty">No reports match</div>}</div>
    </div>
  </div>
}

// ─── Builder ──────────────────────────────────────────────────────────────────
function Builder({ cat, onSaved }: { cat: Catalogue; onSaved: (key: string) => void }) {
  const { success, error } = useToast()
  const [sources, setSources] = useState<{ key: string; label: string }[] | null>(null)
  const [src, setSrc] = useState<string>(() => { try { return sessionStorage.getItem('rp-bk-src') || '' } catch { return '' } })
  const [fields, setFields] = useState<Field[] | null>(null)
  const [cols, setCols] = useState<string[]>([])
  const [grp, setGrp] = useState('')
  const [pv, setPv] = useState<Preview | null>(null)
  const [pvErr, setPvErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [dlg, setDlg] = useState<null | 'save' | 'schedule'>(null)
  const seq = useRef(0)

  useEffect(() => { rpApi.sources().then(s => { setSources(s); setSrc(x => s.some(y => y.key === x) ? x : s.find(y => y.key === 'tenders')?.key || s[0]?.key || '') }).catch(e => error('Could not load data sources', errMsg(e))) }, [error])
  useEffect(() => {
    if (!src) return
    try { sessionStorage.setItem('rp-bk-src', src) } catch { /* private mode */ }
    setFields(null); setPv(null)
    rpApi.fields(src).then(f => {
      setFields(f)
      const def = f.filter(x => x.default).map(x => x.key)
      setCols((def.length ? def : f.map(x => x.key)).slice(0, 4))
      setGrp('')                                       // grouping from another source is never kept
    }).catch(e => { setFields([]); setPvErr(errMsg(e, 'Could not load columns')) })
  }, [src])
  useEffect(() => {
    if (!src || !fields) return
    const my = ++seq.current
    setLoading(true); setPvErr('')
    const t = setTimeout(() => {
      rpApi.preview({ source: src, fields: cols, group: grp || null }).then(r => { if (my === seq.current) setPv(r) })
        .catch(e => { if (my === seq.current) { setPv(null); setPvErr(errMsg(e, 'Preview failed')) } }).finally(() => { if (my === seq.current) setLoading(false) })
    }, 250)
    return () => clearTimeout(t)
  }, [src, fields, cols, grp])

  const fmt = (v: any, f: string) => v == null || v === '' ? <span className="mu">—</span> : f === 'inr' ? inr(Number(v)) : f === 'd' ? fd(String(v)) : f === 'pill' ? <Pill s={String(v)} /> : f === 'num' ? Number(v).toLocaleString('en-IN') : String(v)
  const srcLabel = sources?.find(s => s.key === src)?.label || ''

  return <div className="g g12">
    <div className="panel"><div className="ph">Report builder</div><div className="pb">
      <label className="lb">Data source</label>
      <select className="in mb" value={src} onChange={e => setSrc(e.target.value)} disabled={!sources}>{(sources || []).map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
      <label className="lb">Columns</label>
      <div className="bcols">{!fields ? <small className="mu">Loading…</small> : fields.map(f => <label key={f.key} className="row">
        <input type="checkbox" checked={cols.includes(f.key)} onChange={e => setCols(c => e.target.checked ? [...c, f.key] : c.filter(x => x !== f.key))} /> {f.label}</label>)}</div>
      <label className="lb mt">Group by</label>
      <select className="in" value={grp} onChange={e => setGrp(e.target.value)}><option value="">None</option>{(fields || []).filter(f => f.groupable).map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
      <div className="row mt" style={{ gap: 6 }}>
        <button type="button" className="btn p" disabled={!fields || (!cols.length && !grp)} onClick={() => setDlg('save')}>Save</button>
        <button type="button" className="btn" disabled={!fields || !cat.can.schedule || (!cols.length && !grp)} title={cat.can.schedule ? 'Save the report, then schedule its e-mail delivery' : "You don't have permission to schedule reports"}
          onClick={() => setDlg('schedule')}>Schedule</button>
      </div>
    </div></div>
    <div className="panel"><div className="ph">Live preview{pv && <><span className="fl" /><small className="mu">{pv.grouped ? `${pv.rows.length} groups · ${pv.total} records` : `${Math.min(50, pv.rows.length)} of ${pv.total} records`}</small></>}</div>
      <div className={`tw ${loading ? 'busy' : ''}`}>{pvErr ? <div className="empty">{pvErr}</div> : !pv ? <div className="empty">{loading ? 'Loading…' : 'Choose columns to preview'}</div>
        : pv.grouped ? (pv.rows.length ? <table className="t"><thead><tr><th>{pv.group_label}</th><th className="r">Count</th><th className="r">Total value</th></tr></thead>
          <tbody>{pv.rows.map(r => <tr key={r.g}><td>{r.g}</td><td className="r">{r.n}</td><td className="r">{inr(r.v)}</td></tr>)}</tbody></table> : <div className="empty">No records</div>)
          : pv.cols.length ? (pv.rows.length ? <table className="t"><thead><tr>{pv.cols.map(c => <th key={c.k} className={c.fmt === 'inr' ? 'r' : ''}>{c.t}</th>)}</tr></thead>
            <tbody>{pv.rows.slice(0, 50).map((r, i) => <tr key={r.id ?? i}>{pv.cols.map(c => <td key={c.k} className={c.fmt === 'inr' ? 'r' : ''}>{fmt(r[c.k], c.fmt)}</td>)}</tr>)}</tbody></table>
            : <div className="empty">No records</div>) : <div className="empty">Choose columns to preview</div>}</div>
    </div>
    {dlg && <SaveModal srcLabel={srcLabel} then={dlg} onClose={() => setDlg(null)} onSave={async (b) => {
      const r = await rpApi.save({ source: src, fields: cols, group: grp || null, ...b })
      success('Report saved to Catalogue', r.name)
      return r.key
    }} cat={cat} onDone={key => { setDlg(null); onSaved(key) }} />}
  </div>
}

function SaveModal({ srcLabel, then, cat, onClose, onSave, onDone }: { srcLabel: string; then: 'save' | 'schedule'; cat: Catalogue; onClose: () => void
  onSave: (b: { name: string; description: string; visibility: string }) => Promise<string>; onDone: (key: string) => void }) {
  const { error } = useToast()
  const [v, setV] = useState({ name: '', description: '', visibility: 'private' })
  const [bad, setBad] = useState('')
  const [busy, setBusy] = useState(false)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const save = async () => {
    if (v.name.trim().length < 3) { setBad('Give the report a name (at least 3 characters)'); return }
    if (busy) return
    setBusy(true)
    try { const k = await onSave({ name: v.name.trim(), description: v.description.trim(), visibility: v.visibility }); then === 'schedule' ? setSavedKey(k) : onDone(k) }
    catch (e) { error('Report not saved', errMsg(e)) } finally { setBusy(false) }
  }
  const title = useMemo(() => then === 'schedule' ? 'Save & schedule report' : 'Save report', [then])
  if (savedKey) return <ScheduleModal rkey={savedKey} cat={cat} existing={null} period="FY" onClose={() => onDone(savedKey)} onDone={() => onDone(savedKey)} />
  return <Modal title={title} width={480} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : then === 'schedule' ? 'Save & continue' : 'Save'}</button></>}>
    <div className="fg2">
      <div className="f1"><label>Report name *</label><input className={`in ${bad ? 'bad' : ''}`} maxLength={150} value={v.name} onChange={e => { setV({ ...v, name: e.target.value }); setBad('') }} placeholder={`e.g. ${srcLabel} by status`} />{bad && <div className="ferr">{bad}</div>}</div>
      <div className="f1"><label>Description</label><input className="in" maxLength={500} value={v.description} onChange={e => setV({ ...v, description: e.target.value })} /></div>
      <div className="f1"><label>Visible to</label><select className="in" value={v.visibility} onChange={e => setV({ ...v, visibility: e.target.value })}>
        <option value="private">Only me</option><option value="org">Everyone in the organisation (each sees only the records they may access)</option></select></div>
    </div>
  </Modal>
}
