// Report view – prototype v17 repView(): crumb "Reports / <category>", title + "description · generated <date time> · <company>",
// reporting period (This FY · Last 90 days · Last 30 days), ☆ Favourite · Schedule · Email, then strip(KPIs), the report's own
// charts (g2) and the "Data" panel (gridHTML → BwGrid) with the report's own columns. Server-side PDF · Excel · CSV in the grid tools.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Modal } from '@/pages/notifications/Modal'
import ComposeModal, { type ComposeInit } from '@/pages/notifications/ComposeModal'
import { inboxApi, type Mailbox } from '@/pages/notifications/inboxApi'
import { Av, BarPct, Bars, Donut, Funnel, HBars, Line, Panel, Pill } from '@/pages/customers/kit'
import { chartFmt, errMsg, fd, inr, kpiText, rpApi, type Catalogue, type Chart, type Col, type Period, type Report, type Schedule } from './reportsApi'

const PAL = ['#0F6E8C', '#B26B00', '#1B8559', '#7A4DB8', '#C13B2A', '#3E63A8', '#6B7D2A', '#B0447A']
const TONE: Record<string, string> = { Won: 'ok', Approved: 'ok', Active: 'ok', Completed: 'ok', Positive: 'ok', Success: 'ok', Released: 'mu', Lost: 'ba', Rejected: 'ba',
  Negative: 'ba', Expired: 'ba', Pending: 'wa', Draft: 'mu', Neutral: 'mu', 'Follow-up': 'wa', Paused: 'mu' }

export default function ReportView({ rkey, cat, onBack, onChanged }: { rkey: string; cat: Catalogue; onBack: () => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const [period, setPeriod] = useState<Period>(() => { try { return (sessionStorage.getItem('rp-period') as Period) || 'FY' } catch { return 'FY' } })
  const [d, setD] = useState<Report | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [dlg, setDlg] = useState<null | 'schedule' | 'email'>(null)
  const [compose, setCompose] = useState<{ init: ComposeInit; mailbox: Mailbox | null } | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)

  const load = useCallback(() => {
    setBusy(true); setErr('')
    rpApi.run(rkey, period).then(setD).catch(e => { setErr(errMsg(e, 'Could not run this report')) }).finally(() => setBusy(false))
  }, [rkey, period])
  useEffect(() => { try { sessionStorage.setItem('rp-period', period) } catch { /* private mode */ } load() }, [load, period])

  const toggleFav = async () => {
    if (!d) return
    try { await rpApi.fav(d.key, !d.fav); setD({ ...d, fav: !d.fav }); onChanged() } catch (e) { error('Favourite not saved', errMsg(e)) }
  }
  const exportFile = async (fmt: string) => {
    if (exporting || !d) return
    setExporting(fmt)
    try { const n = await rpApi.exportFile(d.key, period, fmt); success(`${fmt} downloaded`, n) } catch (e) { error(`${fmt} export failed`, errMsg(await blobErr(e))) } finally { setExporting(null) }
  }

  const openRow = useCallback((r: Record<string, any>) => {
    const o = d?.open
    if (!o) return
    if (o.route) { navigate(o.route); return }
    const id = r.id
    if (!id && id !== 0) return
    const to = ({ opportunities: `/opportunities?open=${id}`, leads: `/leads?open=${id}`, tenders: `/tenders/${id}`, emdbg: `/emdbg?open=${id}`,
      workorders: `/workorders?open=${id}`, travel: `/travel?open=${id}` } as Record<string, string>)[o.module || '']
    if (to) navigate(to)
  }, [d, navigate])

  const cols: GridCol<Record<string, any>>[] = useMemo(() => (d?.cols || []).map(c => gridCol(c, navigate)), [d?.cols, navigate])

  if (!d) return <>
    <div className="crumb"><a onClick={onBack}>Reports</a></div>
    <div className="panel"><div className="empty">{err ? <>{err} <button type="button" className="btn s" onClick={load}>Retry</button></> : 'Running report…'}</div></div>
  </>

  const gen = new Date(d.generated)
  const tools = cat.can.export ? <span className="row" style={{ gap: 4, display: 'inline-flex' }}>
    {(['PDF', 'Excel', 'CSV'] as const).map(f => <button key={f} type="button" className="btn s" disabled={!!exporting} onClick={() => exportFile(f)} title={`Download ${f} (generated on the server)`}>
      <Ic n="dl" size={12} /> {exporting === f ? '…' : f}</button>)}</span> : undefined

  return <div className={busy ? 'busy' : ''}>
    <div className="crumb"><a onClick={onBack}>Reports</a> / {d.cat}</div>
    <div className="pg rv"><div><h1>{d.n}</h1><div className="mu">{d.d} · generated {fd(d.generated)} {gen.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · {d.company}</div></div><span className="fl" />
      <select className="in sm" style={{ width: 120 }} value={period} onChange={e => setPeriod(e.target.value as Period)} aria-label="Reporting period">
        {cat.periods.map(p => <option key={p.v} value={p.v}>{p.l}</option>)}</select>
      <button type="button" className="btn" onClick={toggleFav}>{d.fav ? '★ Favourite' : '☆ Favourite'}</button>
      <button type="button" className="btn" disabled={!cat.can.schedule} title={cat.can.schedule ? undefined : "You don't have permission to schedule reports"} onClick={() => setDlg('schedule')}>
        <Ic n="clock" /> {d.schedule ? 'Scheduled' : 'Schedule'}</button>
      <button type="button" className="btn" disabled={!cat.can.share} title={cat.can.share ? undefined : "You don't have permission to e-mail reports"} onClick={() => setDlg('email')}><Ic n="mail" /> Email</button>
    </div>
    {(d.note || d.basis !== undefined) && <div className="note inf mb">{d.period_label}: {fd(d.start)} – {fd(d.end)} · {d.basis ? `period applies to ${d.basis.toLowerCase()}` : 'not limited by the period'}{d.note ? ` · ${d.note}` : ''}
      {d.schedule && <> · scheduled {d.schedule.frequency}, next {d.schedule.next_run ? fd(d.schedule.next_run) : '—'}{d.schedule.last_status ? `, last ${d.schedule.last_status}` : ''}</>}</div>}
    {d.k.length > 0 && <div className="strip">{d.k.map(k => <div key={k.l} className={`st ${k.dc || ''}`}><div className="sth"><label>{k.l}</label></div><b className={k.dc || ''}>{kpiText(k)}</b></div>)}</div>}
    {d.c.length > 0 && <div className="g g2 mb top">{d.c.map(c => <Panel key={c.t} title={c.t}><ChartView c={c} /></Panel>)}</div>}
    {d.cols.length > 0 && <Panel title="Data" z>
      <BwGrid id={`rep-${d.key}`} cols={cols} rows={d.rows} rid={r => String(r.id)} onRow={d.open ? openRow : undefined} tools={tools} canExport={cat.can.export}
        empty="No records for this period." />
      {d.truncated && <div className="note" style={{ margin: 8 }}>Showing the first {d.rows.length.toLocaleString('en-IN')} of {d.total.toLocaleString('en-IN')} rows – download PDF, Excel or CSV for every row.</div>}
    </Panel>}
    {dlg === 'schedule' && <ScheduleModal rkey={d.key} cat={cat} existing={d.schedule} period={period} onClose={() => setDlg(null)}
      onDone={s => { setDlg(null); setD(x => x ? { ...x, schedule: s } : x); onChanged() }} />}
    {dlg === 'email' && <EmailModal d={d} cat={cat} period={period} onClose={() => setDlg(null)} onReady={c => { setDlg(null); setCompose(c) }} />}
    {compose && <ComposeModal init={compose.init} mailbox={compose.mailbox} onClose={() => setCompose(null)}
      onDone={r => { setCompose(null); r.status === 'sent' ? success('Report e-mailed') : r.status === 'scheduled' ? success('E-mail scheduled') : warning('E-mail saved', `Status: ${r.status}`) }} />}
  </div>
}

async function blobErr(e: any) {
  const data = e?.response?.data
  if (data instanceof Blob) {
    try { const j = JSON.parse(await data.text()); return { response: { data: j } } } catch { /* not JSON */ }
  }
  return e
}

function gridCol(c: Col, navigate: (to: string) => void): GridCol<Record<string, any>> {
  const v = (r: Record<string, any>) => r[c.k]
  const base = { k: c.k, t: c.t, w: c.w || (c.f === 'inr' ? 112 : c.f === 'pill' ? 118 : c.f === 'bar' ? 124 : ['date', 'd'].includes(c.f) ? 122 : c.f === 'id' ? 124 : c.r ? 100 : 158), r: c.r }
  const num = (r: Record<string, any>) => { const x = Number(v(r)); return Number.isFinite(x) ? x : null }
  switch (c.f) {
    case 'id': return { ...base, fn: r => <b>{v(r)}</b>, txt: r => String(v(r) ?? '') }
    case 'inr': return { ...base, money: c.money, sum: c.sum, fn: r => v(r) == null ? '—' : inr(v(r)), txt: r => String(v(r) ?? ''), sv: r => num(r) ?? 0, sumv: r => num(r) ?? 0, sumFmt: n => inr(n) }
    case 'int': case 'num': return { ...base, sum: c.sum, fn: r => v(r) == null || v(r) === '' ? <span className="mu">—</span> : Number(v(r)).toLocaleString('en-IN', { maximumFractionDigits: 1 }),
      txt: r => String(v(r) ?? ''), sv: r => num(r) ?? -1, ...(c.sum ? { sumv: (r: Record<string, any>) => num(r) ?? 0, sumFmt: (n: number) => n.toLocaleString('en-IN') } : {}) }
    case 'pct': return { ...base, fn: r => v(r) == null ? '—' : `${v(r)}%`, txt: r => String(v(r) ?? ''), sv: r => num(r) ?? -1 }
    case 'bar': return { ...base, fn: r => v(r) == null ? '—' : <BarPct v={Number(v(r))} />, txt: r => String(v(r) ?? ''), sv: r => num(r) ?? -1 }
    case 'd': case 'date': return { ...base, date: true, fn: r => fd(v(r)), txt: r => String(v(r) ?? '').slice(0, 10), sv: r => String(v(r) ?? '') }
    case 'pill': return { ...base, fn: r => v(r) && v(r) !== '—' ? <Pill s={String(v(r))} t={TONE[String(v(r))]} /> : <span className="mu">—</span>, txt: r => String(v(r) ?? '') }
    case 'user': return { ...base, fn: r => v(r) ? <span className="row" style={{ gap: 6, display: 'inline-flex', alignItems: 'center' }}><Av name={String(v(r))} />{v(r)}</span> : <span className="mu">—</span>, txt: r => String(v(r) ?? '') }
    case 'journey': return { ...base, fn: r => v(r) ? <><span className="pill ac">{v(r)}</span> <small className="mu">{((r.journey?.steps) || []).map((s: any) => s.done ? '●' : '○').join('')}</small></> : <span className="mu">—</span>, txt: r => String(v(r) ?? '') }
    case 'link360': return { ...base, fn: r => <a onClick={e => { e.stopPropagation(); navigate(`/customers/${r.id}`) }}>{v(r)}</a>, txt: r => String(v(r) ?? '') }
    case 'result': return { ...base, fn: r => r.ok ? <Pill s="Success" t="ok" /> : <Pill s={r.why || 'Failed'} t="ba" />, txt: r => (r.ok ? 'Success' : r.why || 'Failed') }
    case 'active': return { ...base, fn: r => <Pill s={String(v(r))} t={v(r) === 'Active' ? 'ok' : 'mu'} />, txt: r => String(v(r) ?? '') }
    default: return { ...base, fn: r => v(r) == null || v(r) === '' ? '' : <span title={String(v(r))}>{String(v(r))}</span>, txt: r => String(v(r) ?? '') }
  }
}

function ChartView({ c }: { c: Chart }) {
  const f = chartFmt(c.f)
  const d = c.d.map((x, i) => ({ ...x, c: x.c || undefined, _i: i }))
  if (!d.length || (c.type !== 'funnel' && d.every(x => !x.v))) return <div className="empty" style={{ padding: 16 }}>Nothing to show</div>
  if (c.type === 'hbars') return <HBars d={d} lw={c.lw} vw={c.vw} f={f} />
  if (c.type === 'bars') return <Bars d={d} h={c.h} f={v => String(Math.round(v * 10) / 10)} />
  if (c.type === 'donut') return <Donut d={d.map((x, i) => ({ l: x.l, v: x.v, c: x.c || PAL[i % PAL.length] }))} c={c.f === 'inr' ? inr(d.reduce((a, b) => a + b.v, 0)) : undefined} f={c.f === 'inr' ? inr : undefined} />
  if (c.type === 'funnel') return <Funnel d={d} />
  return <Line ser={[{ n: c.t, c: PAL[0], v: d.map(x => x.v) }]} labels={d.map(x => x.l)} h={c.h || 130} f={f} />
}

// ─── Schedule report (prototype modal: Frequency · Format · Send to | Remove schedule · Cancel · Save schedule) ──
export function ScheduleModal({ rkey, cat, existing, period, onClose, onDone }: { rkey: string; cat: Catalogue; existing: Schedule | null; period: Period
  onClose: () => void; onDone: (s: Schedule | null) => void }) {
  const { success, error } = useToast()
  const [v, setV] = useState({ frequency: existing?.frequency || cat.frequencies[1] || cat.frequencies[0], format: existing?.format || 'PDF',
    recipients: existing ? existing.recipients.join(', ') : cat.me.email })
  const [bad, setBad] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const list = v.recipients.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean)
    const wrong = list.find(x => !/^[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,}$/.test(x))
    if (!list.length) { setBad('Add at least one recipient'); return }
    if (wrong) { setBad(`'${wrong}' is not a valid e-mail address`); return }
    if (busy) return
    setBusy(true)
    try { const s = await rpApi.saveSchedule(rkey, { ...v, period: existing?.period || period }); success('Report scheduled', `${s.frequency} · next ${s.next_run ? fd(s.next_run) : '—'}`); onDone(s) }
    catch (e) { error('Schedule not saved', errMsg(e)) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy) return
    setBusy(true)
    try { await rpApi.removeSchedule(rkey); success('Schedule removed'); onDone(null) } catch (e) { error('Schedule not removed', errMsg(e)) } finally { setBusy(false) }
  }
  return <Modal title="Schedule report" width={440} onClose={onClose} foot={<>
    {existing && <button type="button" className="btn d" disabled={busy} onClick={remove}>Remove schedule</button>}<span className="fl" />
    <button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save schedule'}</button></>}>
    <div className="fg2">
      <div><label>Frequency</label><select className="in" value={v.frequency} onChange={e => setV({ ...v, frequency: e.target.value })}>{cat.frequencies.map(x => <option key={x}>{x}</option>)}</select></div>
      <div><label>Format</label><select className="in" value={v.format} onChange={e => setV({ ...v, format: e.target.value })}>{cat.formats.map(x => <option key={x}>{x}</option>)}</select></div>
      <div className="f1"><label>Send to</label><input className={`in ${bad ? 'bad' : ''}`} value={v.recipients} onChange={e => { setV({ ...v, recipients: e.target.value }); setBad('') }} placeholder="name@company.com, …" />
        {bad && <div className="ferr">{bad}</div>}</div>
    </div>
    {existing?.last_status && <small className="mu">Last run {existing.last_run ? fd(existing.last_run) : ''}: {existing.last_status}{existing.last_error ? ` – ${existing.last_error}` : ''}</small>}
  </Modal>
}

// ─── Email: generate the file (stored in Document Hub), then open the Inbox composer with it attached ──
function EmailModal({ d, cat, period, onClose, onReady }: { d: Report; cat: Catalogue; period: Period; onClose: () => void; onReady: (c: { init: ComposeInit; mailbox: Mailbox | null }) => void }) {
  const { error } = useToast()
  const [fmt, setFmt] = useState('PDF')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await rpApi.email(d.key, period, fmt)
      let mailbox: Mailbox | null = null
      try { mailbox = await inboxApi.mailbox() } catch { mailbox = null }
      onReady({ init: { subject: r.subject, body: r.body, attachments: [r.attachment] }, mailbox })
    } catch (e) { error('Report not prepared', errMsg(e)) } finally { setBusy(false) }
  }
  return <Modal title="Email report" width={420} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
    <button type="button" className="btn p" disabled={busy || !cat.can.docs} onClick={go}>{busy ? 'Generating…' : 'Generate & compose'}</button></>}>
    <div className="fg2"><div className="f1"><label>Attach as</label><select className="in" value={fmt} onChange={e => setFmt(e.target.value)}>{cat.formats.map(x => <option key={x}>{x}</option>)}</select></div></div>
    <small className="mu">{cat.can.docs ? `The ${d.period_label.toLowerCase()} report is generated now, saved to your Document Hub and attached to a new message.`
      : 'Attaching a report needs Document Hub access – use PDF / Excel / CSV download instead.'}</small>
  </Modal>
}
