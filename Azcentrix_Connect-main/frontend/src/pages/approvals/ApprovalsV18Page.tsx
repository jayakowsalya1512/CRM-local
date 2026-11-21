// Approvals – prototype v18 R.approvals():
// crumb Control · "Approvals" · My preferences · Approval policies (Process Designer → policies by stage); away note;
// seven KPI cards (Pending on me · All pending · Value awaiting · Overdue (SLA) · Approved · 30d · Rejected · 30d ·
// Avg. turnaround); tabs Pending on me | Raised by me | All pending | Decided; purpose distribution bar + legend;
// grid Request | Purpose | What is being requested | Record | Customer | Value | Requested by | Requested on |
// Waiting for | Approval chain | SLA | Priority | Status; the approval drawer (?open=<key>). Data: /api/v1/approvals360.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Av } from '@/pages/customers/kit'
import { approvalsApi, errMsg, fd, ft, inr, type Kpis, type Meta, type NotifyPrefs, type Prefs, type Query, type QueryResult, type Row } from './approvalsApi'
import ApprovalDrawer from './ApprovalDrawer'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './approvals.css'

const Pill = ({ s, t }: { s: string; t?: string }) => <span className={`pill ${t || ({ Pending: 'wa', Approved: 'ok', Rejected: 'ba', High: 'ba', Medium: 'wa', Low: 'mu' } as Record<string, string>)[s] || 'inf'}`}>{s}</span>
type Filters = { status: string; priority: string; requester: number | null; approver: number | null; date_from: string | null; date_to: string | null; sla: string; decided_days: number | null }
const NOF: Filters = { status: '', priority: '', requester: null, approver: null, date_from: null, date_to: null, sla: '', decided_days: null }

export default function ApprovalsV18Page() {
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { error, success } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [k, setK] = useState<Kpis | null>(null)
  const [tab, setTab] = useState<string>('')
  const [cat, setCat] = useState('all')
  const [sort, setSort] = useState('sla')
  const [flt, setFlt] = useState<Filters>(NOF)
  const [q, setQ] = useState('')
  const [page, setPage] = useState({ offset: 0, limit: 25 })
  const [data, setData] = useState<QueryResult & { loading: boolean }>({ items: [], total: 0, base: 0, purposes: [], loading: true })
  const [rev, setRev] = useState(0)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const open = sp.get('open') || ''
  const setOpen = useCallback((key: string) => setSp(s => { const n = new URLSearchParams(s); if (key) n.set('open', key); else n.delete('open'); return n }), [setSp])
  const changed = useCallback(() => setRev(r => r + 1), [])

  const loadMeta = useCallback(() => approvalsApi.meta().then(m => { setMeta(m); setTab(t => t || m.prefs.tab); setCat(m.prefs.cat || 'all'); setSort(m.prefs.sort || 'sla') })
    .catch(e => error(errMsg(e, 'Could not load Approvals'))), [error])
  useEffect(() => { void loadMeta() }, [loadMeta])
  useEffect(() => { approvalsApi.kpis().then(setK).catch(() => undefined) }, [rev])
  const query = useMemo<Query>(() => ({ view: tab || 'Pending on me', q, purpose: cat === 'all' ? '' : cat, ...flt, sort, ...page }), [tab, q, cat, flt, sort, page])
  useEffect(() => {
    if (!tab) return
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => approvalsApi.query(query).then(r => { if (live) setData({ ...r, loading: false }) })
      .catch(e => { if (live) { setData(d => ({ ...d, items: [], total: 0, loading: false })); error(errMsg(e, 'Could not load approvals')) } }), q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [query, rev]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = (t: string, f: Partial<Filters> = {}, s?: string) => { setTab(t); setFlt({ ...NOF, ...f }); if (s) setSort(s); setPage(p => ({ ...p, offset: 0 })) }
  const purposeOf = useMemo(() => Object.fromEntries((meta?.purposes || []).map(p => [p.k, p])), [meta])
  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'id', t: 'Request', w: 130, fn: r => <b>{r.id}</b> },
    { k: 'pp', t: 'Purpose', w: 180, txt: r => purposeOf[r.pp]?.l || r.pp, fn: r => { const p = purposeOf[r.pp]; return p ? <span className="apc8-p" style={{ ['--pc' as string]: p.c }}><Ic n={p.i} size={13} /> {p.l}</span> : r.pp } },
    { k: 'title', t: 'What is being requested', w: 300, fn: r => <span title={r.title}>{r.title.slice(0, 70)}{r.info_open ? <> <span className="pill wa">info requested</span></> : null}</span> },
    { k: 'ref', t: 'Record', w: 150, fn: r => r.route ? <a onClick={e => { e.stopPropagation(); navigate(r.route!) }}>{r.ref}</a> : r.ref },
    { k: 'cust', t: 'Customer', w: 170 },
    { k: 'value', t: 'Value', w: 110, r: true, money: true, sum: true, sumv: r => r.value || 0, sumFmt: n => inr(n), sv: r => r.value ?? -1, fn: r => r.value ? inr(r.value) : <span className="mu">—</span> },
    { k: 'by', t: 'Requested by', w: 190, txt: r => r.by, fn: r => <span className="ucell"><Av name={r.by} /><span>{r.by}<small>{r.byRole}</small></span></span> },
    { k: 'req', t: 'Requested on', w: 140, txt: r => r.req || '', fn: r => <>{fd(r.req)}<br /><small className="mu">{ft(r.req)}</small></> },
    { k: 'cur', t: 'Waiting for', w: 190, txt: r => r.cur, fn: r => r.status === 'Pending' ? <span className="ucell"><Av name={r.cur} /><span>{r.cur}<small>{r.curRole}</small></span></span> : <span className="mu">{r.status === 'Approved' ? 'Completed' : r.status}</span> },
    { k: 'chain', t: 'Approval chain', w: 300, txt: r => r.chain.map(c => c.role || c.user).join(' > '), fn: r => <span className="chain">{r.chain.map((c, i) => <span key={i} className="row" style={{ gap: 3, display: 'inline-flex' }}>
      {i > 0 && <span className="ar">›</span>}<span className={`cn ${c.state}`} title={`${c.user} · ${c.state}`}><Av name={c.user} />{c.role || c.user}</span></span>)}</span> },
    { k: 'sla', t: 'SLA', w: 120, txt: r => r.sla.txt, fn: r => <span className={r.sla.cls}>{r.sla.txt}</span> },
    { k: 'priority', t: 'Priority', w: 90, fn: r => <Pill s={r.priority} /> },
    { k: 'status', t: 'Status', w: 100, fn: r => <Pill s={r.status} /> },
  ], [purposeOf, navigate])

  const sum = data.purposes.reduce((a, p) => a + p.n, 0)
  const pf = meta?.prefs
  const awayTo = pf?.away && pf.away_to ? meta?.people.find(p => p.id === pf.away_to)?.name : null
  const exportCsv = async () => { try { const b = await approvalsApi.exportCsv({ ...query, offset: 0, limit: 5000 }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = 'approvals.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000) } catch (e) { error(errMsg(e, 'Could not export')) } }
  const fset = (f: Partial<Filters>) => { setFlt(x => ({ ...x, ...f })); setPage(p => ({ ...p, offset: 0 })) }
  const tools = <span className="ctools">
    <select className="in sm" aria-label="Sort" value={sort} onChange={e => setSort(e.target.value)}>{Object.entries(meta?.sorts || {}).map(([k_, l]) => <option key={k_} value={k_}>{l}</option>)}</select>
    {tab === 'Decided' || tab === 'Raised by me' ? <select className="in sm" aria-label="Status" value={flt.status} onChange={e => fset({ status: e.target.value })}><option value="">All statuses</option>{['Pending', 'Approved', 'Rejected', 'Withdrawn'].map(s => <option key={s}>{s}</option>)}</select> : null}
    <select className="in sm" aria-label="Priority" value={flt.priority} onChange={e => fset({ priority: e.target.value })}><option value="">Any priority</option>{['High', 'Medium', 'Low'].map(s => <option key={s}>{s}</option>)}</select>
    <select className="in sm" aria-label="Requested by" value={flt.requester ?? ''} onChange={e => fset({ requester: e.target.value ? Number(e.target.value) : null })}><option value="">Any requester</option>{meta?.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <select className="in sm" aria-label="Waiting for" value={flt.approver ?? ''} onChange={e => fset({ approver: e.target.value ? Number(e.target.value) : null })}><option value="">Any approver</option>{meta?.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    <input className="in sm" type="date" aria-label="Requested from" value={flt.date_from || ''} onChange={e => fset({ date_from: e.target.value || null })} />
    <input className="in sm" type="date" aria-label="Requested to" value={flt.date_to || ''} min={flt.date_from || undefined} onChange={e => fset({ date_to: e.target.value || null })} />
    {(flt.sla || flt.decided_days) && <span className="chip on" role="button" onClick={() => fset({ sla: '', decided_days: null })}>{flt.sla ? 'Overdue only' : `Last ${flt.decided_days} d`} ×</span>}
    {meta?.can.export && <button type="button" className="btn s" onClick={exportCsv}><Ic n="dl" /> CSV</button>}
  </span>

  return <div className="bwi apv8">
    <div className="pg"><div><div className="crumb">Control</div><h1>Approvals</h1></div><span className="fl" />
      <button type="button" className="btn" onClick={() => setPrefsOpen(true)} disabled={!meta}><Ic n="gear" /> My preferences</button>
      {meta?.can.policies && <button type="button" className="btn" onClick={() => navigate('/workflow?policies=1')}><Ic n="git" /> Approval policies</button>}</div>
    {awayTo && <div className="note inf mb"><Ic n="users" /> While you are away, new approvals go to <b>{awayTo}</b>{pf?.away_till ? ` until ${fd(pf.away_till)}` : ''}. <a onClick={() => setPrefsOpen(true)}>Change</a></div>}
    <div className="strip ap7">{([
      ['Pending on me', k?.mine, k?.mine ? 'twarn' : '', () => go('Pending on me')],
      ['All pending', k?.pending, '', () => go('All pending')],
      ['Value awaiting', k ? inr(k.value) : undefined, '', () => go('All pending', {}, 'val')],
      ['Overdue (SLA)', k?.overdue, k?.overdue ? 'tbad' : '', () => go('All pending', { sla: 'overdue' }, 'sla')],
      ['Approved · 30d', k?.approved, 'tok', () => go('Decided', { status: 'Approved', decided_days: 30 }, 'new')],
      ['Rejected · 30d', k?.rejected, '', () => go('Decided', { status: 'Rejected', decided_days: 30 }, 'new')],
      ['Avg. turnaround', k ? (k.turnaround != null ? `${k.turnaround} h` : '—') : undefined, '', () => go('Decided', { decided_days: 30 }, 'new')],
    ] as [string, string | number | undefined, string, () => void][]).map(([l, v, dc, fn]) => <div key={l} className={`st clk ${dc}`} role="button" tabIndex={0} onClick={fn}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn() } }}><div className="sth"><label>{l}</label></div><b>{v ?? '…'}</b></div>)}</div>
    <div className="panel">
      <div className="tabs mb" role="tablist">{(meta?.views || []).map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`}
        onClick={() => go(t, {}, undefined)} onKeyDown={e => { if (e.key === 'Enter') go(t) }}>{t}</div>)}</div>
      <div className="axm">
        <div className="axm-bar">{data.purposes.map(p => <i key={p.k} role="button" title={`${p.l}: ${p.n}`} style={{ flex: p.n, background: p.c, opacity: cat !== 'all' && cat !== p.k ? .25 : 1 }}
          onClick={() => { setCat(p.k); setPage(x => ({ ...x, offset: 0 })) }} />)}{!sum && <i style={{ flex: 1, background: 'var(--bw-ln2)' }} />}</div>
        <div className="axm-lg"><a className={cat === 'all' ? 'on' : ''} onClick={() => { setCat('all'); setPage(x => ({ ...x, offset: 0 })) }}>All purposes <b>{data.base}</b></a>
          {data.purposes.map(p => <a key={p.k} className={cat === p.k ? 'on' : ''} style={{ ['--pc' as string]: p.c }} onClick={() => { setCat(p.k); setPage(x => ({ ...x, offset: 0 })) }}>
            <i /><Ic n={p.i} size={12} /> {p.l} <b>{p.n}</b></a>)}</div>
      </div>
      <div className="pb z" aria-busy={data.loading}>
        <BwGrid id="approvals-v18" cols={cols} rows={data.items} rid={r => r.key} onRow={r => setOpen(r.key)} tools={tools} canExport={false}
          server={{ total: data.total, onChange: s => setPage({ offset: s.offset, limit: s.limit }) }} onQuery={s => { setQ(x => x === s.q ? x : s.q) }}
          empty={data.loading ? 'Loading…' : 'No requests in this view'} />
      </div>
    </div>
    {open && meta && <ApprovalDrawer k={open} meta={meta} onClose={() => setOpen('')} onChanged={changed}
      onNext={() => { const nx = tab === 'Pending on me' ? data.items.find(r => r.key !== open && r.status === 'Pending') : null; setOpen(nx && meta.prefs.next !== 'close' ? nx.key : '') }} />}
    {prefsOpen && meta && <PrefsModal meta={meta} onClose={() => setPrefsOpen(false)} onSaved={(p, msg) => { setPrefsOpen(false); success(msg); setMeta(m => m ? { ...m, prefs: p } : m); setTab(p.tab); setCat(p.cat); setSort(p.sort); changed(); void loadMeta() }} />}
  </div>
}

/* ── My approval preferences (prototype A.apPrefs) ── */
function PrefsModal({ meta, onClose, onSaved }: { meta: Meta; onClose: () => void; onSaved: (p: Prefs, msg: string) => void }) {
  const { error } = useToast()
  const [p, setP] = useState<Prefs>({ ...meta.prefs, away_till: meta.prefs.away_till || new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) })
  const [n, setN] = useState<NotifyPrefs>(meta.notify)
  const [rm, setRm] = useState((meta.prefs.remarks || []).join('\n'))
  const [busy, setBusy] = useState(false)
  const others = meta.people.filter(x => x.id !== meta.me.id)
  const ck = (on: boolean, label: string, onChange: (v: boolean) => void, disabled = false, title?: string) => <label className="row" style={{ gap: 6, opacity: disabled ? .55 : 1 }} title={title}>
    <input type="checkbox" checked={on} disabled={disabled} onChange={e => onChange(e.target.checked)} /> {label}</label>
  const save = async () => {
    if (p.away && !p.away_to) { error('Choose who gets your approvals while you are away'); return }
    setBusy(true)
    try { const r = await approvalsApi.savePrefs({ ...p, away_to: p.away ? p.away_to : null, remarks: rm.split('\n').map(x => x.trim()).filter(Boolean), notify: { app: n.app, email: n.email, digest: n.digest } }); onSaved(r, `Preferences saved for ${meta.me.name}`) }
    catch (e) { error(errMsg(e, 'Could not save the preferences')) } finally { setBusy(false) }
  }
  const reset = async () => { setBusy(true); try { const r = await approvalsApi.resetPrefs(); onSaved(r, 'Preferences reset') } catch (e) { error(errMsg(e, 'Could not reset')) } finally { setBusy(false) } }
  return <Modal title={<><Ic n="gear" /> My approval preferences</>} width={640} onClose={onClose} foot={<>
    <button type="button" className="btn g" disabled={busy} onClick={reset}>Reset to defaults</button><span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save preferences'}</button></>}>
    <p className="mu" style={{ margin: '0 0 12px' }}>Saved for <b>{meta.me.name}</b> only – other users keep their own settings.</p>
    <div className="fg">
      <div><label htmlFor="ap-tab">Open on</label><select id="ap-tab" className="in" value={p.tab} onChange={e => setP(x => ({ ...x, tab: e.target.value }))}>{meta.views.map(v => <option key={v}>{v}</option>)}</select></div>
      <div><label htmlFor="ap-sort">Sort requests by</label><select id="ap-sort" className="in" value={p.sort} onChange={e => setP(x => ({ ...x, sort: e.target.value }))}>{Object.entries(meta.sorts).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div><label htmlFor="ap-cat">Default purpose</label><select id="ap-cat" className="in" value={p.cat} onChange={e => setP(x => ({ ...x, cat: e.target.value }))}>
        <option value="all">All requests</option>{meta.purposes.filter(x => x.k !== 'other').map(x => <option key={x.k} value={x.k}>{x.l}</option>)}</select></div>
      <div><label htmlFor="ap-next">After I decide</label><select id="ap-next" className="in" value={p.next} onChange={e => setP(x => ({ ...x, next: e.target.value as Prefs['next'] }))}>
        <option value="next">Open the next request</option><option value="close">Close the panel</option></select></div>
      <div className="f1"><label>Purposes I want to see</label><div className="row wrap" style={{ gap: '6px 14px' }}>{meta.purposes.map(x => <span key={x.k}>
        {ck(!p.hide.includes(x.k), x.l, v => setP(s => ({ ...s, hide: v ? s.hide.filter(h => h !== x.k) : [...s.hide, x.k] })))}</span>)}</div></div>
      <div className="f1"><label>Notify me about new requests</label><div className="row wrap" style={{ gap: '6px 14px' }}>
        {ck(n.app, 'In the app', v => setN(s => ({ ...s, app: v })))}{ck(n.email, 'Email', v => setN(s => ({ ...s, email: v })))}
        {ck(false, 'WhatsApp', () => undefined, !n.whatsapp_available, 'WhatsApp delivery is not configured for this workspace')}
        {ck(n.digest, 'Daily digest at 9:00', v => setN(s => ({ ...s, digest: v })))}
        {ck(false, 'Only high value (₹50 L+) by WhatsApp', () => undefined, !n.whatsapp_available, 'WhatsApp delivery is not configured for this workspace')}</div>
        <small className="mu">Saved to Inbox &amp; Notifications → Delivery preferences (Approvals, Daily digest).{!n.whatsapp_available ? ' WhatsApp is not configured for this workspace.' : ''}</small></div>
      <div><label className="row" style={{ gap: 6 }}><input type="checkbox" checked={p.away} onChange={e => setP(x => ({ ...x, away: e.target.checked }))} /> I am away – delegate to</label>
        <select className="in" aria-label="Delegate to" value={p.away_to ?? ''} disabled={!p.away} onChange={e => setP(x => ({ ...x, away_to: e.target.value ? Number(e.target.value) : null }))}>
          <option value="">Choose…</option>{others.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      <div><label htmlFor="ap-till">Until</label><input id="ap-till" className="in" type="date" disabled={!p.away} min={new Date().toISOString().slice(0, 10)} value={p.away_till || ''} onChange={e => setP(x => ({ ...x, away_till: e.target.value }))} /></div>
      <div className="f1"><label htmlFor="ap-rm">My quick remarks <small className="mu">one per line – shown above the Approve button</small></label>
        <textarea id="ap-rm" className="in" rows={3} value={rm} onChange={e => setRm(e.target.value)} /></div>
    </div>
  </Modal>
}
