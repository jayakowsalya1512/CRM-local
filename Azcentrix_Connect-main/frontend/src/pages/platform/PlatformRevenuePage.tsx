import { useCallback, useEffect, useState } from 'react'
import { platformApi, type RevenueOverview } from '@/services/platformApi'
import { C, Empty, Note, Panel, Strip, errMsg, fd, inr, useKpiPopup } from '@/components/platform/bw'
import { Donut, Heat, ValueBars } from '@/components/platform/charts'

// Layout follows the Bidwise prototype v7 Revenue analytics page (P.rev): six KPIs, MRR movement · this month, Plan mix,
// Cohort retention (logo %). Figures come from Billing & Metering prices and the subscription ledger; anything the ledger
// doesn't cover yet, or that has no source data (acquisition cost), is shown as unavailable rather than estimated.
const pct = (v: number) => `${v.toFixed(v >= 100 || Number.isInteger(v) ? 0 : 1)}%`
const MOVES = [null, 'New', 'Expansion', 'Contraction', 'Churn', null] as const  // ValueBars order: Start, New, …, End
const since = (w: { since: string; truncated: boolean }) => w.truncated ? `since ${fd(w.since)} (ledger start)` : undefined

export default function PlatformRevenuePage() {
  const [data, setData] = useState<RevenueOverview | null>(null)
  const [error, setError] = useState('')
  const [openKpi, kpiPopup] = useKpiPopup()
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.revenue(); setData(next); setError('') } catch (err) { setError(errMsg(err, 'Revenue analytics unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const d = data
  const mv = d?.movement
  const kpis = d && <Strip items={[
    { l: 'MRR', v: inr(d.mrr), sp: d.trend, kpi: 'revenue.mrr',
      d: d.mrr_change != null ? `${d.mrr_change >= 0 ? '+' : ''}${d.mrr_change.toFixed(1)}%` : undefined, c: d.mrr_change != null && d.mrr_change < 0 ? C.ba : C.ok },
    { l: 'ARR', v: inr(d.arr), kpi: 'revenue.arr' },
    { l: 'Net revenue retention', kpi: 'revenue.nrr', v: d.nrr?.value != null ? <span style={{ color: C.ok }}>{pct(d.nrr.value)}</span> : '—',
      d: !d.nrr ? 'no ledger yet' : d.nrr.value == null ? 'no paying accounts at start' : since(d.nrr) },
    { l: 'Logo churn · 90d', kpi: 'revenue.churn', v: d.churn?.value != null ? pct(d.churn.value) : '—',
      d: !d.churn ? 'no ledger yet' : d.churn.value == null ? 'no paying accounts at start' : since(d.churn) ?? `${d.churn.lost} of ${d.churn.accounts}` },
    { l: 'ARPA', kpi: 'revenue.arpa', v: d.arpa != null ? inr(d.arpa) : '—', d: d.arpa == null ? 'no paying accounts' : undefined },
    { l: 'LTV : CAC', kpi: 'revenue.ltv_cac', v: d.ltv_cac != null ? `${d.ltv_cac.toFixed(1)}×` : '—', d: d.ltv_cac == null ? 'no acquisition-cost data' : undefined },
  ]} />

  const movement = !d ? <Empty>{error || 'Loading…'}</Empty> : !mv ? <Empty>The subscription ledger has no history yet.</Empty> : <>
    <ValueBars h={160} f={inr} onPick={i => { const m = MOVES[i]; if (m) openKpi({ kpi: 'revenue.movement', title: `MRR movement · ${m}`, value: inr(mv[m.toLowerCase() as 'new']), query: { facet: m } }) }} data={[
      { l: 'Start', v: mv.start, c: C.mu },
      { l: 'New', v: mv.new, c: C.ok, t: `New: ${inr(mv.new)} · ${mv.accounts.new} account(s)` },
      { l: 'Expansion', v: mv.expansion, c: C.ac, t: `Expansion: ${inr(mv.expansion)} · ${mv.accounts.expansion} account(s)` },
      { l: 'Contraction', v: mv.contraction, c: C.wa, txt: mv.contraction ? `−${inr(mv.contraction)}` : inr(0), t: `Contraction: −${inr(mv.contraction)} · ${mv.accounts.contraction} account(s)` },
      { l: 'Churn', v: mv.churn, c: C.ba, txt: mv.churn ? `−${inr(mv.churn)}` : inr(0), t: `Churn: −${inr(mv.churn)} · ${mv.accounts.churn} account(s)` },
      { l: 'End', v: mv.end, c: C.mu },
    ]} />
    {mv.truncated && <div className="mt-1 text-[11px]" style={{ color: C.mu }}>Start is the MRR at the subscription ledger start ({fd(mv.since)}); earlier changes this month weren’t recorded.</div>}
  </>

  const plans = d?.plans ?? []
  const planMix = !d ? <Empty>{error || 'Loading…'}</Empty> : <>
    <Donut data={plans.map(p => ({ l: p.plan, v: p.mrr }))} f={inr} center={inr(d.mrr)} onPick={i => openKpi({ kpi: 'revenue.mrr', title: `MRR · ${plans[i].plan}`, value: inr(plans[i].mrr), query: { facet: plans[i].plan } })} />
    {!plans.length && <div className="mt-1 text-[11px]" style={{ color: C.mu }}>No paying accounts{d.trials ? ` – ${d.trials} tenant${d.trials === 1 ? ' is' : 's are'} on trial` : ''}.</div>}
  </>

  const co = d?.cohorts
  const cohorts = !co ? <Empty>{error || 'Loading…'}</Empty> : <>
    <Heat rows={co.rows.map(r => r.label)} cols={co.months} cell={(i, j) => {
      const r = co.rows[i], x = r.cells[j]
      return x ? { v: x.pct, t: `${r.label} ${co.months[j]}: ${x.pct}% (${x.retained} of ${x.eligible} still paying)` }
        : { v: null, t: `${r.label} ${co.months[j]}: ${r.accounts ? 'not reached yet' : 'no accounts in this cohort'}` }
    }} />
    <div className="mt-1.5 text-[11px]" style={{ color: C.mu }}>
      Paying accounts by the fiscal quarter they first paid; dashed cells have no data yet.
      {co.paying_at_baseline > 0 && ` ${co.paying_at_baseline} account(s) already paying when the ledger started aren’t in a cohort.`}
    </div>
  </>

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Command</div><h1 className="text-xl font-semibold">Revenue analytics</h1></div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {kpiPopup}
    {kpis}
    <div className="mb-2 grid gap-2 lg:grid-cols-2">
      <Panel title="MRR movement · this month">{movement}</Panel>
      <Panel title="Plan mix">{planMix}</Panel>
    </div>
    <Panel title="Cohort retention (logo %)">{cohorts}</Panel>
  </div>
}
