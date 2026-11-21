import { Bar, Empty, inr, num } from '@/components/platform/bw'
import { Columns, Donut, HBars } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, monthKeys, useBoard, type Period } from '../data'
import { drill } from '../records'
import { ErrorBox, Kpis, LoadingBox, NoAccess, PickFunnel, Sec, Unavailable, useDrill } from '../ui'

type LeadsBoard = {
  kpis: { total: number; spark: number[]; new_period: number; qualified_pct: number; converted: number; converted_pct: number; unassigned: number; avg_score: number | null }
  months: string[]; created_6m: number[]
  sources: { l: string; v: number }[]; conversion_by_source: { l: string; v: number }[]
  funnel: { l: string; v: number }[]; scoring_available: boolean
  ageing: { l: string; v: number }[]; open_count: number
  owners: { owner: string; owner_id: number; leads: number; converted: number; conversion: number; value: number; hot: number | null }[]
}

export default function Leads({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const r = useBoard<LeadsBoard>('leads', period, can(PERM.leads), nonce)
  if (r.denied) return <NoAccess what="the Leads dashboard" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load leads'} />
  const d = r.data, k = d.kpis, keys = monthKeys()
  const SCORE = 'Lead scoring is not configured in the CRM yet, so scores cannot be shown. Add scoring rules to see the average and distribution here.'

  return <>
    <Kpis items={[
      { l: 'Leads', v: num(k.total), sp: k.spark, drill: () => drill('leads', 'all', 'Leads', { value: num(k.total) }) },
      { l: 'New · period', v: num(k.new_period), drill: () => drill('leads', 'new_period', 'New · period', { value: num(k.new_period), sub: 'Leads created in the selected period' }) },
      { l: 'Qualified or later', v: `${k.qualified_pct}%`, drill: () => drill('leads', 'qualified', 'Qualified or later', { value: `${k.qualified_pct}%` }) },
      { l: 'Converted to deal / bid', v: num(k.converted), d: `${k.converted_pct}%`, dc: 'tok', drill: () => drill('leads', 'converted', 'Converted to deal / bid', { value: num(k.converted) }) },
      { l: 'Avg lead score', v: '—', d: 'Not configured', drill: () => ({ title: 'Avg lead score', value: '—', body: <Unavailable>{SCORE}</Unavailable> }) },
      { l: 'Unassigned', v: num(k.unassigned), dc: 'twarn', drill: () => drill('leads', 'unassigned', 'Unassigned', { value: num(k.unassigned) }) },
    ]} />

    <div className="bw-g g3 mb">
      <Sec t="Leads created · 6 months">
        <Columns h={120} data={d.created_6m.map((v, i) => ({ l: d.months[i], v }))} onPick={i => open(drill('leads', `month:${keys[i]}`, `Leads created · ${d.months[i]}`))} />
      </Sec>
      <Sec t="Lead sources">
        {d.sources.length ? <Donut f={v => num(v)} data={d.sources} onPick={i => open(drill('leads', `source:${d.sources[i].l}`, `Source · ${d.sources[i].l}`))} /> : <Empty>No leads yet</Empty>}
      </Sec>
      <Sec t="Conversion by source">
        <HBars lw={100} vw={40} rows={d.conversion_by_source.map(s => ({ ...s, text: `${s.v}%` }))} onPick={i => open(drill('leads', `source:${d.conversion_by_source[i].l}`, `Conversion · ${d.conversion_by_source[i].l}`))} />
      </Sec>
    </div>

    <div className="bw-g g3 mb">
      <Sec t="Lead stage funnel">
        <PickFunnel data={d.funnel} onPick={i => open(drill('leads', d.funnel[i].l === 'Converted' ? 'converted' : `status:${d.funnel[i].l}`, `Stage · ${d.funnel[i].l}`))} />
      </Sec>
      <Sec t="Score distribution"><Unavailable>{SCORE}</Unavailable></Sec>
      <Sec t="Open lead ageing">
        <Donut f={v => num(v)} center={num(d.open_count)} data={d.ageing} onPick={i => open(drill('leads', `age:${d.ageing[i].l}`, `Open leads · ${d.ageing[i].l}`))} />
      </Sec>
    </div>

    <Sec t="Owner-wise lead performance" flush>
      {d.owners.length ? <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left">
        <thead><tr><th>Owner</th><th className="text-right">Leads</th><th className="text-right">Converted</th><th>Conversion</th><th className="text-right">Value</th><th className="text-right">Hot leads (75+)</th></tr></thead>
        <tbody>{d.owners.map(o => <tr key={o.owner_id} className="cursor-pointer" onClick={() => open(drill('leads', `owner:${o.owner_id}`, `Leads · ${o.owner}`, { value: num(o.leads) }))}>
          <td>{o.owner}</td><td className="text-right tabular-nums">{num(o.leads)}</td><td className="text-right tabular-nums">{num(o.converted)}</td>
          <td style={{ minWidth: 140 }}><Bar value={o.conversion} /></td><td className="text-right tabular-nums">{inr(o.value)}</td>
          <td className="text-right" title="Lead scoring is not configured" style={{ color: 'var(--bw-mu)' }}>—</td>
        </tr>)}</tbody>
      </table></div> : <Empty>No assigned leads</Empty>}
    </Sec>
  </>
}
