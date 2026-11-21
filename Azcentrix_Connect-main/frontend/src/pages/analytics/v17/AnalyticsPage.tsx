// Analytics – prototype v17 R.analytics: crumb "Intelligence" · "Analytics" · FY dropdown · ✉ Share, nine tabs
// (Executive · Sales funnel & journeys · Pipeline health · Win / loss & competitors · Customers · Bids & OEM ·
// Revenue & collections · People & productivity · Geography), each with its own strip, chart grid (g3 / g2) and table.
// All values come from /api/v1/analytics-v17 for the selected fiscal year; "—" means the data isn't recorded.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Modal } from '@/pages/notifications/Modal'
import ComposeModal, { type ComposeInit } from '@/pages/notifications/ComposeModal'
import { inboxApi, type Mailbox } from '@/pages/notifications/inboxApi'
import { Av, BarPct, Bars, Donut, Funnel, HBars, Line, Panel, Pill } from '@/pages/customers/kit'
import { ANT, anApi, errMsg, fd, fmtOf, inr, kpiText, type Chart, type Col, type Heat, type Meta, type TabData } from './analyticsApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import './analytics.css'

const PAL = ['#0F6E8C', '#B26B00', '#1B8559', '#7A4DB8', '#C13B2A', '#3E63A8', '#6B7D2A', '#B0447A']

export default function AnalyticsPage() {
  const [sp, setSp] = useSearchParams()
  const { error, success, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [fy, setFy] = useState('')
  const [d, setD] = useState<TabData | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [compose, setCompose] = useState<{ init: ComposeInit; mailbox: Mailbox | null } | null>(null)
  const tab = (ANT as readonly string[]).includes(sp.get('tab') || '') ? sp.get('tab')! : ANT[0]
  const setTab = (t: string) => setSp(s => { const n = new URLSearchParams(s); if (t === ANT[0]) n.delete('tab'); else n.set('tab', t); return n })

  useEffect(() => { anApi.meta().then(m => { setMeta(m); setFy(f => f || m.fys[0]?.v || '') }).catch(e => setErr(errMsg(e, 'Could not load Analytics'))) }, [])
  const load = useCallback(() => {
    if (!fy) return
    setBusy(true); setErr('')
    anApi.tab(tab, fy).then(setD).catch(e => { setErr(errMsg(e, 'Could not load this tab')); error('Could not load analytics', errMsg(e)) }).finally(() => setBusy(false))
  }, [tab, fy, error])
  useEffect(load, [load])

  const share = async () => {
    if (sharing) return
    setSharing(true)
    try {
      const r = await anApi.share(tab, fy)
      let mailbox: Mailbox | null = null
      try { mailbox = await inboxApi.mailbox() } catch { mailbox = null }
      setConfirm(false)
      setCompose({ init: { subject: r.subject, body: r.body, attachments: [r.attachment] }, mailbox })
    } catch (e) { error('Snapshot not shared', errMsg(e)) } finally { setSharing(false) }
  }

  return <div className="bwi anl">
    {/* prototype v17 R.analytics wrapper: slim .dhero above the page header */}
    <div className="anl-hero"><div><h2>Analytics</h2><div className="sub">Funnel, pipeline health, customers, bids and people – all from live data.</div></div></div>
    <div className="pg"><div><div className="crumb">Intelligence</div><h1>Analytics</h1></div><span className="fl" />
      <select className="in sm" style={{ width: 130 }} value={fy} onChange={e => setFy(e.target.value)} aria-label="Financial year">
        {(meta?.fys || []).map(f => <option key={f.v} value={f.v}>{f.l}</option>)}</select>
      <button type="button" className="btn" disabled={!meta?.can.share || !d} title={meta?.can.share ? 'E-mail a PDF snapshot of this tab' : "You don't have permission to share analytics"}
        onClick={() => setConfirm(true)}><Ic n="mail" /> Share</button>
    </div>
    <div className="tabs mb" role="tablist">{ANT.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
    {err && !d ? <div className="panel"><div className="empty">{err} <button type="button" className="btn s" onClick={load}>Retry</button></div></div>
      : !d || d.tab !== tab ? <div className="panel"><div className="empty">Loading…</div></div>
        : <div className={busy ? 'busy' : ''}><TabView d={d} /></div>}
    {confirm && d && <Modal title="Share analytics" width={420} onClose={() => setConfirm(false)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setConfirm(false)}>Cancel</button>
      <button type="button" className="btn p" disabled={sharing} onClick={share}>{sharing ? 'Generating…' : 'Generate & compose'}</button></>}>
      <p style={{ margin: 0 }}>A PDF snapshot of <b>{d.tab}</b> for <b>{d.fy_label}</b> ({d.company}) is generated with your access, saved to your Document Hub and attached to a new e-mail.</p>
    </Modal>}
    {compose && <ComposeModal init={compose.init} mailbox={compose.mailbox} onClose={() => setCompose(null)}
      onDone={r => { setCompose(null); r.status === 'sent' ? success('Analytics snapshot e-mailed') : r.status === 'scheduled' ? success('E-mail scheduled') : warning('E-mail saved', `Status: ${r.status}`) }} />}
  </div>
}

function TabView({ d }: { d: TabData }) {
  const navigate = useNavigate()
  const notes = d.notes || {}
  const charts = d.c || []
  const rows: Chart[][] = []
  let i = 0
  for (const n of d.layout || []) { rows.push(charts.slice(i, i + n)); i += n }
  if (i < charts.length) rows.push(charts.slice(i))
  const geo = d.tab === 'Geography'
  return <>
    {d.na && <div className="note mb">{d.na}</div>}
    {d.k.length > 0 && <div className="strip">{d.k.map(k => <div key={k.l} className={`st ${k.dc || ''} ${k.v == null ? 'na' : ''}`} title={notes[k.l]}>
      <div className="sth"><label>{k.l}</label></div><b className={k.dc || ''}>{kpiText(k)}</b></div>)}</div>}
    {geo ? <div className="g g2 mb">{charts.map(c => <ChartPanel key={c.t} c={c} note={notes[c.t]} navigate={navigate} />)}{d.heat && <HeatPanel h={d.heat} note={notes[d.heat.t]} />}</div>
      : rows.map((r, ri) => <div key={ri} className={`g g${Math.min(3, Math.max(2, r.length))} ${ri < rows.length - 1 || d.table || d.heat ? 'mb' : ''}`}>
        {r.map(c => <ChartPanel key={c.t} c={c} note={notes[c.t]} navigate={navigate} />)}</div>)}
    {geo && (d.c2 || []).map(c => <ChartPanel key={c.t} c={c} note={notes[c.t]} navigate={navigate} />)}
    {!geo && d.heat && <HeatPanel h={d.heat} note={notes[d.heat.t]} />}
    {d.table && <Panel title={d.table.t} z><DataTable id={`an-${d.tab}`} cols={d.table.cols} rows={d.table.rows} navigate={navigate} />
      {notes[d.table.t] && <div className="cnote" style={{ padding: '0 10px 8px' }}>{notes[d.table.t]}</div>}</Panel>}
  </>
}

function ChartPanel({ c, note, navigate }: { c: Chart; note?: string; navigate: (to: string) => void }) {
  if (c.type === 'table') return <Panel title={c.t} z><DataTable id={`an-${c.t}`} cols={c.cols || []} rows={c.rows || []} navigate={navigate} /></Panel>
  return <Panel title={c.t}><ChartBody c={c} />{(note || c.note) && <div className="cnote">{note || c.note}</div>}</Panel>
}

function ChartBody({ c }: { c: Chart }) {
  const f = fmtOf(c.f)
  if (c.type === 'line') {
    const ser = (c.ser || []).map(s => {
      const last = s.v.reduce((acc: number, v, i) => v != null ? i : acc, -1)
      return { n: s.n, c: PAL[s.c % PAL.length], v: s.v.slice(0, last + 1).map(v => v ?? 0) }
    }).filter(s => s.v.length)
    if (!ser.length || ser.every(s => s.v.every(v => !v))) return <div className="empty" style={{ padding: 16 }}>Nothing to show</div>
    return <Line ser={ser} labels={c.labels || []} h={c.h || 130} f={c.f === 'inr' ? inr : f} />
  }
  const data = c.d.filter(x => x.v != null).map(x => ({ l: x.l, v: Number(x.v), c: x.c }))
  if (c.type === 'hbars' && c.d.some(x => x.v == null)) {
    const shown = c.d.map(x => ({ l: x.l, v: Number(x.v ?? 0) }))
    if (shown.every(x => !x.v)) return <div className="empty" style={{ padding: 16 }}>No recorded dates to measure yet</div>
    return <HBars d={shown} lw={c.lw} vw={c.vw} f={v => v ? f(v) : '—'} />
  }
  if (!data.length || (c.type !== 'funnel' && data.every(x => !x.v))) return <div className="empty" style={{ padding: 16 }}>Nothing to show</div>
  if (c.type === 'hbars') return <HBars d={data} lw={c.lw} vw={c.vw} f={f} />
  if (c.type === 'bars') return <Bars d={data} h={c.h} f={v => String(Math.round(v * 10) / 10)} />
  if (c.type === 'donut') return <Donut d={data.map((x, i) => ({ ...x, c: x.c || PAL[i % PAL.length] }))} c={c.f === 'inr' ? inr(data.reduce((a, b) => a + b.v, 0)) : undefined} f={c.f === 'inr' ? inr : undefined} />
  return <Funnel d={data} />
}

function HeatPanel({ h, note }: { h: Heat; note?: string }) {
  const days = h.cols.length === 14
  const cols = days ? h.cols.map(x => x.slice(8)) : h.cols
  const label = (s: string) => days ? s.split(' ')[0] : s
  return <Panel title={h.t}>{!h.rows.length ? <div className="empty" style={{ padding: 16 }}>Nothing to show</div> : <div className="hmw">
    <div className="hm" style={{ gridTemplateColumns: `90px repeat(${cols.length}, minmax(14px, 1fr))` }}><span />
      {cols.map((c, j) => <small key={j} className="c">{c}</small>)}
      {h.rows.map((r, i) => <div key={i} style={{ display: 'contents' }}><small style={{ lineHeight: '13px' }} title={r}>{label(r)}</small>
        {cols.map((c, j) => {
          const raw = h.raw ? h.raw[i][j] : h.v[i][j]
          const v = days ? Math.min(100, raw ? raw * 35 + 6 : 0) : h.v[i][j]
          return <i key={j} style={{ ['--v' as string]: v }} title={`${r} · ${days ? fd(h.cols[j]) : c}: ${h.fmt === 'inr' ? inr(raw) : `${raw} activit${raw === 1 ? 'y' : 'ies'}`}`} />
        })}</div>)}
    </div></div>}{note && <div className="cnote">{note}</div>}</Panel>
}

function DataTable({ id, cols, rows, navigate }: { id: string; cols: Col[]; rows: Record<string, any>[]; navigate: (to: string) => void }) {
  const gcols: GridCol<Record<string, any>>[] = useMemo(() => cols.map(c => col(c, navigate)), [cols, navigate])
  return <BwGrid id={id} cols={gcols} rows={rows} rid={r => String(r.id ?? JSON.stringify(r))} empty="Nothing to show for this year." />
}

function col(c: Col, navigate: (to: string) => void): GridCol<Record<string, any>> {
  const v = (r: Record<string, any>) => r[c.k]
  const num = (r: Record<string, any>) => { const x = Number(v(r)); return Number.isFinite(x) ? x : -1 }
  const base = { k: c.k, t: c.t, r: c.r, w: c.w || (c.f === 'inr' ? 120 : c.f === 'bar' ? 130 : c.f === 'user' ? 170 : ['deal', 'link360'].includes(c.f) ? 260 : c.r ? 100 : 160) }
  const dash = <span className="mu">—</span>
  switch (c.f) {
    case 'deal': return { ...base, fn: r => <a onClick={e => { e.stopPropagation(); navigate(`/opportunities?open=${r.id}`) }}>{String(v(r) || '').slice(0, 44)}</a>, txt: r => String(v(r) ?? '') }
    case 'link360': return { ...base, fn: r => <a onClick={e => { e.stopPropagation(); navigate(`/customers/${r.id}`) }}>{v(r)}</a>, txt: r => String(v(r) ?? '') }
    case 'order': return { ...base, fn: r => <a onClick={e => { e.stopPropagation(); navigate(`/workorders?open=${r.id}`) }}><b>{v(r)}</b></a>, txt: r => String(v(r) ?? '') }
    case 'inr': return { ...base, money: true, fn: r => v(r) == null ? dash : inr(Number(v(r))), txt: r => String(v(r) ?? ''), sv: num }
    case 'int': return { ...base, fn: r => v(r) == null ? dash : Number(v(r)).toLocaleString('en-IN'), txt: r => String(v(r) ?? ''), sv: num }
    case 'bar': return { ...base, fn: r => v(r) == null ? dash : <BarPct v={Number(v(r))} />, txt: r => String(v(r) ?? ''), sv: num }
    case 'pill': return { ...base, fn: r => v(r) ? <Pill s={String(v(r))} /> : dash, txt: r => String(v(r) ?? '') }
    case 'user': return { ...base, fn: r => v(r) ? <span className="row" style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}><Av name={String(v(r))} />{v(r)}</span> : dash, txt: r => String(v(r) ?? '') }
    case 'date': return { ...base, date: true, fn: r => fd(v(r)), txt: r => String(v(r) ?? '').slice(0, 10), sv: r => String(v(r) ?? '') }
    case 'pctv': return { ...base, fn: r => v(r) == null || v(r) === '' ? dash : `${v(r)}%`, txt: r => String(v(r) ?? ''), sv: num }
    case 'delta': return { ...base, fn: r => { if (v(r) == null) return <span className="mu">—</span>; const x = Number(v(r)); return <span className={x < 0 ? 'tbad' : 'tok'}>{x > 0 ? '+' : ''}{x}%</span> }, txt: r => String(v(r) ?? ''), sv: num }
    default: return { ...base, fn: r => v(r) == null || v(r) === '' ? '' : String(v(r)), txt: r => String(v(r) ?? '') }
  }
}
