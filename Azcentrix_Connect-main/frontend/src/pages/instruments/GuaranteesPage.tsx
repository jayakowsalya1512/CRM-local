// Guarantees & Deposits – prototype v18 R.emd():
// header (Finance & field · <company> · N instruments · New request), alerts (gdAlerts), Total outstanding with the
// stacked distribution and legend + six KPI cards (gdOutstanding), segmented views Register | Awaiting approval |
// Finance desk | Expiry & alerts | By tender, the instrument drawer (?open=<id>) and every lifecycle modal.
// All values come from /api/v1/instruments (company = tenant, isolated in FastAPI).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Switch } from '@/components/platform/bw'
import { useToast } from '@/components/ui/ToastContext'
import { download, dto, errMsg, fd, fdS, GROUP_COLOR, inr, insApi, type Desk, type ListParams, type Meta, type Row, type Summary, type TenderRow, type DepCell } from './instrumentApi'
import InstrumentDrawer from './InstrumentDrawer'
import { ActionModal, NewRequestModal, type ActionKey } from './InstrumentModals'
import InstrumentSettingsModal from './InstrumentSettingsModal'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './instruments.css'

const VIEWS = ['Register', 'Awaiting approval', 'Finance desk', 'Expiry & alerts', 'By tender'] as const
type View = typeof VIEWS[number]
const Pill = ({ s, t }: { s: string; t: string }) => <span className={`pill ${t}`}>{s}</span>
const EMPTY_SUMMARY: Summary = { outstanding: 0, live: 0, groups: [], kpis: [], alerts: [], counts: {} }

export default function GuaranteesPage() {
  const [sp, setSp] = useSearchParams()
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [sum, setSum] = useState<Summary>(EMPTY_SUMMARY)
  const [total, setTotal] = useState<number | null>(null)
  const [rev, setRev] = useState(0)
  const [creating, setCreating] = useState(false)
  const [settings, setSettings] = useState(false)
  const [act, setAct] = useState<{ k: ActionKey; r: Row } | null>(null)
  const view: View = (VIEWS as readonly string[]).includes(sp.get('v') || '') ? sp.get('v') as View : 'Register'
  const openId = sp.get('open') ? Number(sp.get('open')) : null
  const preset = useMemo(() => ({ type: sp.get('type') || '', status: sp.get('status') || '' }), [sp])
  const setParam = useCallback((k: string, v: string | null, extra?: Record<string, string | null>) => setSp(s => {
    const n = new URLSearchParams(s); for (const [kk, vv] of Object.entries({ [k]: v, ...(extra || {}) })) { if (vv) n.set(kk, vv); else n.delete(kk) } return n }), [setSp])
  const setView = (v: string, filter?: { type_key: string; status: string }) => setParam('v', v === 'Register' ? null : v, { type: filter?.type_key || null, status: filter?.status || null })
  const open = useCallback((id: number) => setParam('open', String(id)), [setParam])
  const close = useCallback(() => setParam('open', null), [setParam])
  const changed = useCallback(() => setRev(r => r + 1), [])
  const loadMeta = useCallback(() => insApi.meta().then(setMeta).catch(e => error(errMsg(e, 'Could not load Guarantees & Deposits'))), [error])
  useEffect(() => { void loadMeta() }, [loadMeta])
  useEffect(() => {   // header count, alerts, outstanding and view counts
    insApi.list({ view: 'Register', type: '', status: '', validity: '', link: '', q: '', f: {}, adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 1 })
      .then(r => { setSum(r.summary); setTotal(r.total_all) }).catch(e => error(errMsg(e, 'Could not load instruments')))
  }, [rev, error])
  const can = meta?.can
  const group = (meta?.companies.length || 0) > 1
  const onAction = (k: ActionKey, r: Row) => setAct({ k, r })
  const done = (m: string) => { setAct(null); (/approval/i.test(m) && !/^Approved/.test(m) ? warning : success)(m); changed() }

  return <div className="bwi gdp">
    <div className="pg">
      <div><div className="crumb">Finance &amp; field · {group ? 'all companies' : meta?.company || 'Workspace'}</div><h1>Guarantees &amp; Deposits</h1></div>
      <span className="cnt">{total ?? '…'} instruments</span><span className="fl" />
      {can?.create && <button type="button" className="btn p" disabled={!meta} onClick={() => setCreating(true)}><Ic n="plus" /> New request</button>}
    </div>
    {sum.alerts.map(a => <div key={a.t} className={`gd8-al ${a.c}`}><Ic n={a.c === 'ba' ? 'alert' : a.c === 'inf' ? 'mail' : 'clock'} />
      <div className="fl"><b>{a.t}</b><br /><small>{a.items.map((x, i) => <span key={x.id}>{i ? ' · ' : ''}<a onClick={() => open(x.id)}>{x.s}</a></span>)}</small></div>
      <button type="button" className="btn s" onClick={() => setView(a.view)}>Review</button></div>)}
    <Outstanding s={sum} onView={setView} />
    <div style={{ margin: '4px 0 12px' }}><div className="seg8" role="tablist">{VIEWS.map(v => <button key={v} type="button" role="tab" aria-selected={v === view} className={v === view ? 'on' : ''}
      onClick={() => setView(v)}>{v}{v !== 'Register' && v !== 'By tender' && sum.counts[v] ? <small>{sum.counts[v]}</small> : null}</button>)}</div></div>
    {!meta ? <div className="empty">Loading…</div>
      : view === 'Register' || view === 'Awaiting approval' ? <Register meta={meta} view={view} rev={rev} preset={preset} onOpen={open} />
      : view === 'Finance desk' ? <FinanceDesk meta={meta} rev={rev} onOpen={open} onAction={onAction} />
      : view === 'Expiry & alerts' ? <Expiry meta={meta} rev={rev} onOpen={open} onAction={onAction} onSettings={() => setSettings(true)} onChanged={() => void loadMeta()} />
      : <ByTender meta={meta} rev={rev} onOpen={id => navigate(`/tenders/${id}`)} />}
    {openId && meta && <InstrumentDrawer id={openId} meta={meta} onClose={close} onChanged={changed} />}
    {creating && meta && <NewRequestModal meta={meta} onClose={() => setCreating(false)} onDone={(m, id) => { setCreating(false); done(m); open(id) }} />}
    {act && meta && <ActionModal act={act.k} r={act.r} meta={meta} onClose={() => setAct(null)} onDone={done} />}
    {settings && <InstrumentSettingsModal onClose={() => setSettings(false)} onSaved={() => { void loadMeta(); changed() }} />}
  </div>
}

/* ── Total outstanding + six KPI cards (prototype gdOutstanding) ── */
function Outstanding({ s, onView }: { s: Summary; onView: (v: string, f?: { type_key: string; status: string }) => void }) {
  const tot = s.groups.reduce((a, g) => a + g.v, 0) || 1
  return <div className="gd8-out">
    <div className="gd8-tot"><small>Total outstanding</small><b>{inr(s.outstanding)}</b><span className="mu">{s.live} instrument{s.live === 1 ? '' : 's'} with customers or banks</span>
      <div className="gd8-bar" aria-hidden>{s.groups.filter(g => g.v).map(g => <i key={g.k} style={{ width: `${g.v / tot * 100}%`, background: GROUP_COLOR[g.k] }} title={`${g.l}: ${inr(g.v)}`} />)}</div>
      <div className="gd8-lg">{s.groups.filter(g => g.v || ['EMD', 'PBG'].includes(g.k)).map(g => <span key={g.k}><i style={{ background: GROUP_COLOR[g.k] }} />{g.l}<b>{inr(g.v)}</b><small>{g.n}</small></span>)}</div></div>
    <div className="gd8-side">{s.kpis.map(k => <div key={k.l} className={`gd8-k ${k.c}`} role="button" tabIndex={0} onClick={() => onView(k.view, k.filter)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onView(k.view, k.filter) } }}><small>{k.l}</small><b>{k.n}</b><span>{inr(k.v)}</span></div>)}</div>
  </div>
}

/* ── Register / Awaiting approval (prototype gdCols) ── */
function Register({ meta, view, rev, preset, onOpen }: { meta: Meta; view: View; rev: number; preset: { type: string; status: string }; onOpen: (id: number) => void }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const [flt, setFlt] = useState({ type: preset.type, status: preset.status, validity: '', link: '' })
  useEffect(() => { setFlt(f => ({ ...f, type: preset.type, status: preset.status })) }, [preset])
  const [p, setP] = useState<Omit<ListParams, 'view' | 'type' | 'status' | 'validity' | 'link' | 'q' | 'f'>>({ adv: { logic: 'AND', conds: [] }, sorts: [], offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Row[]; total: number; loading: boolean }>({ items: [], total: 0, loading: true })
  const key = JSON.stringify([view, flt, p, qf, rev])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => insApi.list({ view, ...flt, q: qf.q, f: qf.f, ...p }).then(r => { if (live) setData({ items: r.items, total: r.total, loading: false }) })
      .catch(e => { if (live) { setData({ items: [], total: 0, loading: false }); error(errMsg(e, 'Could not load instruments')) } }), qf.q ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP(s), [])
  const group = meta.companies.length > 1
  const cols: GridCol<Row>[] = useMemo(() => [
    { k: 'code', t: 'ID', w: 130, fn: r => <b>{r.code}</b>, txt: r => r.code },
    ...(group ? [{ k: 'co', t: 'Company', w: 80, fn: () => meta.company || '', txt: () => meta.company || '' } as GridCol<Row>] : []),
    { k: 'type', t: 'Instrument', w: 120, fn: r => <Pill s={r.type} t="ac" />, txt: r => r.type },
    { k: 'tender', t: 'Tender / order', w: 160, txt: r => r.tender || r.wo, fn: r => r.tender_id ? <><a onClick={e => { e.stopPropagation(); navigate(`/tenders/${r.tender_id}`) }}><b>{r.tender}</b></a><br /><small className="mu">{r.tender_no}</small></>
      : r.wo_id ? <><a onClick={e => { e.stopPropagation(); navigate(`/workorders?open=${r.wo_id}`) }}><b>{r.wo}</b></a><br /><small className="mu">order</small></> : r.tender || <span className="mu">—</span> },
    { k: 'customer', t: 'Customer', w: 190 },
    { k: 'mode', t: 'Mode', w: 180, fn: r => r.mode || <span className="mu">—</span> },
    { k: 'amount', t: 'Amount', w: 110, r: true, money: true, sum: true, sumv: r => r.amount, sumFmt: n => inr(n), fn: r => inr(r.amount), sv: r => r.amount },
    { k: 'requested', t: 'Recorded', w: 105, date: true, fn: r => fd(r.requested), sv: r => r.requested || '' },
    { k: 'due', t: 'Required by', w: 130, date: true, sv: r => r.due || '', fn: r => r.due ? <span className={['Pending approval', 'With Finance'].includes(r.status) && dto(r.due) < 0 ? 'tbad' : ''}>{fd(r.due)}
      {['Pending approval', 'With Finance'].includes(r.status) && <><br /><small className={dto(r.due) <= 2 ? 'tbad' : 'mu'}>{dto(r.due) < 0 ? `${-dto(r.due)} d overdue` : `in ${dto(r.due)} d`}</small></>}</span> : <span className="mu">—</span> },
    { k: 'approved_on', t: 'Approved', w: 105, date: true, sv: r => r.approved_on || '', fn: r => r.approved_on ? fd(r.approved_on) : <span className="mu">—</span>, txt: r => r.approved_on || '' },
    { k: 'utr', t: 'UTR / instrument', w: 160, fn: r => r.utr ? <small>{r.utr}</small> : <span className="mu">—</span> },
    { k: 'validity', t: 'Valid until', w: 135, date: true, sv: r => r.validity || '', fn: r => r.validity ? <span className={r.expired ? 'tbad' : (r.days ?? 99) <= 30 && r.status === 'Active' ? 'twarn' : ''}>{fd(r.validity)}</span> : <span className="mu">—</span> },
    { k: 'eff_status', t: 'Status', w: 150, fn: r => <Pill s={r.eff_status} t={r.tone} />, txt: r => r.eff_status },
    { k: 'next', t: 'Next step', w: 260, fn: r => <small>{r.next}</small> },
  ], [group, meta.company, navigate])
  const exportCsv = async () => { try { download(await insApi.exportCsv({ view, ...flt, q: qf.q }), 'guarantees-deposits.csv') } catch (e) { error(errMsg(e, 'Could not export')) } }
  const on = (k: keyof typeof flt) => (e: { target: { value: string } }) => setFlt(f => ({ ...f, [k]: e.target.value }))
  const tools = <span className="ctools">
    <select className="in sm" aria-label="Instrument" value={flt.type} onChange={on('type')}><option value="">All instruments</option>{meta.types.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</select>
    <select className="in sm" aria-label="Status" value={flt.status} onChange={on('status')}><option value="">All statuses</option>{[...meta.statuses, 'Expired'].map(s => <option key={s}>{s}</option>)}</select>
    <select className="in sm" aria-label="Validity" value={flt.validity} onChange={on('validity')}><option value="">Any validity</option><option value="expired">Expired</option>
      <option value="15">Expiring ≤ 15 d</option><option value="30">Expiring ≤ 30 d</option><option value="60">Expiring ≤ 60 d</option><option value="none">No validity</option></select>
    <input className="in sm" aria-label="Tender / order" placeholder="Tender / order…" value={flt.link} onChange={on('link')} style={{ width: 130 }} />
    {meta.can.export && <button type="button" className="btn s" onClick={exportCsv} title="Export (CSV)"><Ic n="dl" /> CSV</button>}
  </span>
  return <>
    {view === 'Awaiting approval' && <div className="note inf mb">Requests wait for the Sales Head (and Company Admin above ₹50 L). Approved requests move to the Finance desk automatically.</div>}
    <div className="panel" aria-busy={data.loading}>
      <BwGrid id={view === 'Register' ? 'gd-reg-v18' : 'gd-apr-v18'} cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => onOpen(r.id)} tools={tools} canExport={false}
        server={{ total: data.total, onChange: onServer }} onQuery={onQuery} empty={data.loading ? 'Loading…' : view === 'Awaiting approval' ? 'Nothing is waiting for approval' : 'No instruments match the current filters.'} />
    </div>
  </>
}

/* ── Finance desk (two panels) ── */
function useDesk(rev: number) {
  const { error } = useToast()
  const [d, setD] = useState<Desk | null>(null)
  useEffect(() => { insApi.desk().then(setD).catch(e => error(errMsg(e, 'Could not load the Finance desk'))) }, [rev, error])
  return d
}

function FinanceDesk({ meta, rev, onOpen, onAction }: { meta: Meta; rev: number; onOpen: (id: number) => void; onAction: (k: ActionKey, r: Row) => void }) {
  const navigate = useNavigate()
  const d = useDesk(rev)
  if (!d) return <div className="empty">Loading…</div>
  const S = (L: Row[], k: 'amount' | 'recv_amount' = 'amount') => L.reduce((a, r) => a + (k === 'recv_amount' ? (r.recv_amount ?? r.amount) : r.amount), 0)
  const fin = meta.can.finance
  return <>
    <div className="g g2" style={{ alignItems: 'start' }}>
      <div className="panel"><div className="ph"><Ic n="card" /> Pay or issue · approved by head<span className="fl" /><small className="mu">{d.finance_pay.length} · {inr(S(d.finance_pay))}</small></div>
        <div className="list">{d.finance_pay.length ? d.finance_pay.map(e => <div key={e.id}>
          <div className="fl clk" role="button" tabIndex={0} onClick={() => onOpen(e.id)} onKeyDown={k => { if (k.key === 'Enter') onOpen(e.id) }}>
            <b>{e.type} {inr(e.amount)}</b> · {e.tender || e.wo}<br /><small className="mu">{e.customer.slice(0, 34)} · {e.mode} · approved {fdS(e.approved_on)} by {e.approved_by || '—'}</small><br />
            <small className={e.due && dto(e.due) <= 2 ? 'tbad' : 'mu'}>Required by {fd(e.due)}{e.due ? ` (${dto(e.due)} d)` : ''}</small></div>
          {fin ? <button type="button" className="btn s p" onClick={() => onAction('pay', e)}>{e.bg && e.type_key !== 'TF' ? 'Enter BG' : 'Enter UTR'}</button> : <span className="pill inf">Finance team</span>}</div>)
          : <div className="empty">No payments waiting</div>}</div></div>
      <div className="panel"><div className="ph"><Ic n="check" /> Acknowledge receipts · marked by sales<span className="fl" /><small className="mu">{d.finance_ack.length}</small></div>
        <div className="list">{d.finance_ack.length ? d.finance_ack.map(e => <div key={e.id}>
          <div className="fl clk" role="button" tabIndex={0} onClick={() => onOpen(e.id)} onKeyDown={k => { if (k.key === 'Enter') onOpen(e.id) }}>
            <b>{e.type} {inr(e.recv_amount ?? e.amount)}</b> · {e.tender || e.wo}<br /><small className="mu">Marked by {e.recv_by || '—'} on {fd(e.recv_on)} · {e.recv_ref}</small></div>
          {fin ? <button type="button" className="btn s p" onClick={() => onAction('acknowledge', e)}>Acknowledge</button> : <span className="pill inf">Finance team</span>}</div>)
          : <div className="empty">Nothing to acknowledge</div>}</div></div>
    </div>
    {d.collections_pending > 0 && <div className="note inf mt row"><Ic n="card" /><span className="fl">{d.collections_pending} customer payment{d.collections_pending > 1 ? 's' : ''} against orders also wait for Finance acknowledgement.</span>
      <button type="button" className="btn s" onClick={() => navigate('/workorders')}>Open collections</button></div>}
  </>
}

/* ── Expiry & alerts (two columns + alert rules) ── */
function Expiry({ meta, rev, onOpen, onAction, onSettings, onChanged }: { meta: Meta; rev: number; onOpen: (id: number) => void; onAction: (k: ActionKey, r: Row) => void; onSettings: () => void; onChanged: () => void }) {
  const { success, error } = useToast()
  const d = useDesk(rev)
  const [cfg, setCfg] = useState(meta.config)
  useEffect(() => setCfg(meta.config), [meta.config])
  if (!d) return <div className="empty">Loading…</div>
  const upd = meta.can.update
  const row = (e: Row) => <div key={e.id}><span className={`gd8-dot ${e.expired ? 'ba' : (e.days ?? 99) <= 15 ? 'wa' : 'ok'}`} />
    <div className="fl clk" role="button" tabIndex={0} onClick={() => onOpen(e.id)} onKeyDown={k => { if (k.key === 'Enter') onOpen(e.id) }}>
      <b>{e.type} {inr(e.amount)}</b> · {e.tender || e.wo} · {e.customer.slice(0, 30)}<br />
      <small className={e.expired ? 'tbad' : 'mu'}>{e.expired ? `Expired ${-(e.days ?? 0)} d ago` : `Expires ${fd(e.validity)} · in ${e.days} d`} · {e.mode}</small></div>
    {upd && e.bg && <button type="button" className="btn s" onClick={() => onAction('extend', e)}>Extend</button>}
    {upd && (e.status === 'Active' ? <button type="button" className="btn s" onClick={() => onAction('refund', e)}>Request refund</button>
      : <button type="button" className="btn s" onClick={() => onAction('receive', e)}>Mark received</button>)}</div>
  const rules: [keyof typeof cfg, string, string, string][] = [
    ['alert_expiring', 'EMD / BG expiring', `${cfg.remind_days}, 15 and 7 days before validity`, 'App'],
    ['alert_expired', 'Instrument expired', 'On the day after expiry, then weekly', 'App'],
    ['alert_refund', 'Refund not received', `${cfg.escalate_days} days after the refund request`, 'App'],
    ['alert_received', 'Refund marked received', 'Immediately to Finance for acknowledgement', 'App'],
    ['alert_finance', 'Approved request waiting for Finance', 'When required-by date is within 2 days', 'App'],
  ]
  const toggle = async (k: keyof typeof cfg, v: boolean) => {
    if (!meta.can.settings) return
    try { const r = await insApi.saveConfig({ [k]: v }); setCfg(r); success(v ? 'Alert switched on' : 'Alert switched off'); onChanged() }
    catch (e) { error(errMsg(e, 'Could not change the alert')) }
  }
  return <div className="g g2" style={{ alignItems: 'start' }}>
    <div className="panel"><div className="ph"><Ic n="alert" /> Expired and expiring · next 60 days<span className="fl" /><small className="mu">{d.expiring.length}</small></div>
      <div className="list">{d.expiring.length ? d.expiring.map(row) : <div className="empty">Nothing expires in the next 60 days</div>}</div></div>
    <div className="g" style={{ alignContent: 'start' }}>
      <div className="panel"><div className="ph"><Ic n="clock" /> Refunds requested – not yet back<span className="fl" /><small className="mu">{d.refunds.length}</small></div>
        <div className="list">{d.refunds.length ? d.refunds.map(e => { const ago = e.ret_on ? -dto(e.ret_on) : null; return <div key={e.id}>
          <div className="fl clk" role="button" tabIndex={0} onClick={() => onOpen(e.id)} onKeyDown={k => { if (k.key === 'Enter') onOpen(e.id) }}>
            <b>{e.type} {inr(e.amount)}</b> · {e.tender || e.wo} · {e.customer.slice(0, 26)}<br /><small className={ago != null && ago > 30 ? 'tbad' : 'mu'}>Requested {fd(e.ret_on)}{ago != null ? ` · ${ago} d ago` : ''}</small></div>
          {upd && <button type="button" className="btn s p" onClick={() => onAction('receive', e)}>Mark received</button>}</div> }) : <div className="empty">No refunds outstanding</div>}</div></div>
      <div className="panel"><div className="ph"><Ic n="bell" /> Alert rules<span className="fl" />{meta.can.settings && <button type="button" className="btn g s" onClick={onSettings} title="Setup → Guarantees & deposits"><Ic n="gear" /></button>}</div>
        <div className="list">{rules.map(([k, a, b, ch]) => <div key={k}><div className="fl"><b>{a}</b><br /><small className="mu">{b} · {ch}{cfg.alert_email ? ', Email' : ''}</small></div>
          <Switch on={!!cfg[k]} disabled={!meta.can.settings} label={a} onChange={v => void toggle(k, v)} /></div>)}</div></div>
    </div>
  </div>
}

/* ── By tender ── */
function ByTender({ meta, rev, onOpen }: { meta: Meta; rev: number; onOpen: (id: number) => void }) {
  const { error } = useToast()
  const [rows, setRows] = useState<TenderRow[] | null>(null)
  useEffect(() => { insApi.byTender().then(setRows).catch(e => error(errMsg(e, 'Could not load tenders'))) }, [rev, error])
  const group = meta.companies.length > 1
  const cell = (c: DepCell) => c.req === 'Not required' ? <span className="mu">Not required</span> : c.req === 'Exempted' && !c.status ? <Pill s="Exempted" t="mu" />
    : c.status ? <><Pill s={c.status} t={c.tone || 'inf'} /><br /><small className="mu">{inr(c.amount)}</small></> : <Pill s="Not entered" t="ba" />
  const txt = (c: DepCell) => c.status || c.req
  const cols: GridCol<TenderRow>[] = useMemo(() => [
    { k: 'ref', t: 'Tender', w: 140, fn: t => <a onClick={e => { e.stopPropagation(); onOpen(t.id) }}><b>{t.ref}</b></a>, txt: t => t.ref },
    ...(group ? [{ k: 'co', t: 'Company', w: 80, fn: () => meta.company || '', txt: () => meta.company || '' } as GridCol<TenderRow>] : []),
    { k: 'customer', t: 'Customer', w: 200 },
    { k: 'stage', t: 'Stage', w: 140, fn: t => <Pill s={t.stage} t={t.stage_kind === 'won' ? 'ok' : t.stage_kind === 'lost' ? 'ba' : 'inf'} />, txt: t => t.stage },
    { k: 'submit', t: 'Submission', w: 130, date: true, sv: t => t.submit || '', fn: t => t.submit ? <span className={dto(t.submit) < 0 ? 'mu' : dto(t.submit) <= 7 ? 'twarn' : ''}>{fd(t.submit)}</span> : <span className="mu">—</span> },
    { k: 'e', t: 'EMD', w: 150, fn: t => cell(t.emd), txt: t => txt(t.emd) },
    { k: 'f', t: 'Tender fee', w: 150, fn: t => cell(t.fee), txt: t => txt(t.fee) },
    { k: 'b', t: 'Bid security BG', w: 150, fn: t => cell(t.bg), txt: t => txt(t.bg) },
    { k: 'g', t: 'Bid work', w: 170, fn: t => t.gate.ok ? <Pill s="Unlocked" t="ok" /> : <><Pill s="Locked" t="ba" /><br /><small className="mu">{t.gate.missing[0]}</small></>, txt: t => t.gate.ok ? 'Unlocked' : 'Locked' },
  ], [group, meta.company, onOpen])
  return <div className="panel">{!rows ? <div className="empty">Loading…</div> :
    <BwGrid id="gd-ten-v18" cols={cols} rows={rows} rid={t => String(t.id)} onRow={t => onOpen(t.id)} empty="No tenders yet." />}</div>
}
