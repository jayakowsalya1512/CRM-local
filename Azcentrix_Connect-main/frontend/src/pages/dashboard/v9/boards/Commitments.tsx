// Dashboards › Commitments – prototype v18 dashCommit() (DSYS.splice(5, 0, ['Commitments', 'target', dashCommit])).
// Week bar + Open in Field Sales 360 · commitment KPI cards · Payments committed vs collected (8 weeks) · Attainment by
// team · Overall score (8 weeks) · Leaderboard + Weekly heat-map / Achievement by type · Payment commitments + At risk /
// Commitment submission. Same records and calculations as Field Sales 360 → Commitments (GET /commitments/dashboard).
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { usePermissions } from '@/hooks'
import { Av, Bars, Line, PALC as PAL, Panel, Tbl } from '@/pages/customers/kit'
import { addD, cmApi, cmFmt, errText, first, lakh, pc3, type Dash, type Row } from '@/pages/commitments/commitmentApi'
import { Heat, Kpis, Loading, PayTbl, PBars, Score, WkBar } from '@/pages/commitments/parts'
import { NoAccess } from '../ui'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/instruments/instruments.css'
import '@/pages/commitments/commitments.css'

export default function CommitmentsBoard() {
  const nav = useNavigate()
  const { can } = usePermissions()
  const { success, error } = useToast()
  const [week, setWeek] = useState<string | undefined>(undefined)
  const [d, setD] = useState<Dash | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [n, setN] = useState(0)
  const [busy, setBusy] = useState(false)
  const allowed = can('kam.view')
  useEffect(() => {
    if (!allowed) return
    let alive = true
    setErr(null)
    // prototype cmWk() for the dashboard (CMK 'cmWd') opens on last week – the latest complete week
    const w = week ?? addD(new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10), -7)
    cmApi.dashboard(w).then(r => { if (alive) setD(r) }).catch(e => { if (alive) setErr(errText(e, 'Could not load commitments')) })
    return () => { alive = false }
  }, [week, n, allowed])
  if (!allowed) return <NoAccess what="commitments (Field Sales 360)" />
  if (!d) return <div className="bwi"><Loading err={err} retry={() => setN(x => x + 1)} /></div>

  const a = d.week, types = d.types, self = d.rows.filter(r => !r.mgr), tot = d.tot, pt = types.find(t => t.k === 'pay')
  const wl = a.offset === 0 ? 'this week' : `week ${a.no}`
  const open = () => nav('/kam?tab=commitments')
  const pick = (id: number) => nav(`/kam?tab=commitments&cmp=${id}`)
  const S = d.submission
  const box = (l: string, x: number, y: number) => { const p = y ? Math.round(x / y * 100) : 0
    return <div className="cm8-sb"><small>{l}</small><b>{x}<small> / {y}</small></b><span className="mbar8"><i style={{ width: `${p}%`, background: pc3(p) }} /></span></div> }
  const remindAll = async () => {
    setBusy(true)
    try { const r = await cmApi.remind(S.next.missing.map(m => m.id), S.next.from); r.sent ? success(`Reminder sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}`, `Commit for ${r.week} before the cut-off`) : error('No reminder sent', 'Everyone still to commit has these notifications switched off') }
    catch (e) { error('Reminder not sent', errText(e)) } finally { setBusy(false) }
  }
  const board = [...self].sort((x, y) => (y.score ?? -1) - (x.score ?? -1))

  return <div className="bwi">
    <div className="cm8-bar"><WkBar week={a} onMove={dd => setWeek(dd === 0 ? a.current : addD(a.from, dd))} /><span className="fl" />
      <button type="button" className="btn s" onClick={open}><Ic n="users" /> Open in Field Sales 360</button></div>
    <Kpis tot={tot} types={types} rows={d.rows} pace={a.pace} />
    <div className="g g3 mb" style={{ alignItems: 'start' }}>
      <Panel title="Payments · committed vs collected · 8 weeks">{pt
        ? <Line ser={[{ n: 'Committed (₹ L)', c: PAL[1], v: d.hist.map(h => lakh(h.pay_cv)), fill: false }, { n: 'Collected (₹ L)', c: PAL[2], v: d.hist.map(h => lakh(h.pay_av)) }]} labels={d.hist.map(h => h.w)} h={150} />
        : <div className="empty">Payments are not part of commitments</div>}</Panel>
      <Panel title={`Attainment by team · ${wl}`}><PBars d={d.agg.map(t => ({ l: t.tk, v: t.score || 0, c: pc3(t.score) })).sort((x, y) => y.v - x.v)} /></Panel>
      <Panel title="Overall score · 8 weeks"><Bars d={d.hist.map(h => ({ l: h.w, v: h.score, c: pc3(h.score) }))} h={150} f={v => `${Math.round(v)}%`} /></Panel>
    </div>
    <div className="cm8-d2">
      <Panel title={`Leaderboard · ${wl}`} z><Tbl<Row> rows={board} onRow={r => pick(r.id)} empty="No one has committed for this week" cols={[
        { k: 'n', t: 'Person', fn: r => <><span className="row" style={{ gap: 6 }}><Av name={r.n} />{r.n}</span><small className="mu">{r.tk}</small></> },
        ...types.slice(0, 4).map(t => ({ k: t.k, t: t.n.split(' ')[0], r: true, fn: (r: Row) => { const x = r.ty[t.k]; return x && x.cm ? <span style={{ color: pc3(x.p) }}>{x.p}%</span> : <span className="mu">—</span> } })),
        { k: 'score', t: 'Score', r: true, fn: r => <Score s={r.score} /> },
      ]} /></Panel>
      <div className="cm8-stk">
        <Panel title="Weekly heat-map · score by person"><Heat rows={d.heat.map(h => first(h.n))} cols={d.hist.map(h => h.w)}
          v={(i, j) => Math.min(100, d.heat[i].v[j] ?? 0)} t={(i, j) => `${d.heat[i].n} ${d.hist[j].w}: ${d.heat[i].v[j] == null ? 'no commitment' : `${d.heat[i].v[j]}%`}`} /></Panel>
        <Panel title={`Achievement by type · ${wl}`}><PBars d={types.map(t => ({ l: t.n, v: tot[t.k]?.p ?? 0, c: pc3(tot[t.k]?.p) }))} />
          <div className="cm8-note">{types.map(t => <span key={t.k}><Ic n={t.ic} /> {cmFmt(t, tot[t.k]?.av ?? 0)} of {cmFmt(t, tot[t.k]?.cv ?? 0)}</span>)}</div></Panel>
      </div>
    </div>
    <div className="cm8-d2">
      <Panel title={`Payment commitments · ${wl}`} z><PayTbl L={d.pay} empty="No payment commitments" /></Panel>
      <div className="cm8-stk">
        <Panel title="At risk · below 50%" z>{d.risk.length ? <div className="list">{d.risk.slice(0, 5).map(r => <div key={r.id} role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => pick(r.id)}>
          <Av name={r.n} /><span className="fl"><b>{r.n}</b><br /><small className="mu">{r.tk}</small></span><Score s={r.score} /></div>)}</div>
          : <div className="empty">Nobody is below 50%</div>}</Panel>
        <Panel title="Commitment submission"><div className="cm8-sbs">{box(`Week ${S.cur.no}`, S.cur.sub, S.cur.total)}{box(`Week ${S.next.no} (next)`, S.next.sub, S.next.total)}</div>
          {S.next.missing.length ? <div className="cm8-miss"><small className="mu">Still to commit for next week</small>
            <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>{S.next.missing.map(r => <span key={r.id} className="chip"><Av name={r.n} /> {first(r.n)}</span>)}</div>
            {can('kam.update') && <button type="button" className="btn s mt" disabled={busy} onClick={remindAll}><Ic n="bell" /> Remind all</button>}</div>
            : <div className="cm8-miss mu">Everyone has committed for next week</div>}</Panel>
      </div>
    </div>
  </div>
}
