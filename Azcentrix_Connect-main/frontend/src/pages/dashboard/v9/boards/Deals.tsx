import { useNavigate } from 'react-router-dom'
import { Empty, inr, num } from '@/components/platform/bw'
import { Donut, HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, useBoard, type Period } from '../data'
import { ROUTE, drill } from '../records'
import { ErrorBox, Kpis, LoadingBox, NoAccess, Sec, Unavailable, statusPill, useDrill } from '../ui'

type Deal = { id: number; name: string; customer: string; value: number; stage: string; owner: string | null; days_in_stage: number | null; journey: string }
type DealsBoard = {
  kpis: { open_pipeline: number; weighted: number | null; won_fy: number; won_fy_n: number; win_rate: number; avg_deal: number; avg_cycle: number | null }
  by_stage: { l: string; v: number }[]; by_type: { l: string; v: number }[]; total: number; forecast_available: boolean; forecast?: { l: string; v: number; n: number }[]
  months: string[]; won_6m: number[]; lost_6m: number[]; win_rate_by_type: { l: string; v: number | null }[]
  top_open: Deal[]; stalled: Deal[]
}

const PROB = 'Win probabilities are not configured for the opportunity stages, so a weighted value and forecast categories cannot be calculated. They appear here once stage probabilities are set up.'

export default function Deals({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const navigate = useNavigate()
  const r = useBoard<DealsBoard>('deals', period, can(PERM.deals), nonce)
  if (r.denied) return <NoAccess what="the Deals dashboard" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load deals'} />
  const d = r.data, k = d.kpis
  const type = (i: number) => (i ? 'Quotation' : 'Tender')

  return <>
    <Kpis items={[
      { l: 'Open pipeline', v: inr(k.open_pipeline), drill: () => drill('deals', 'open', 'Open pipeline', { value: inr(k.open_pipeline) }) },
      k.weighted == null ? { l: 'Weighted', v: '—', d: 'Not configured', drill: () => ({ title: 'Weighted', value: '—', body: <Unavailable>{PROB}</Unavailable> }) }
        : { l: 'Weighted', v: inr(k.weighted), drill: () => drill('deals', 'open', 'Weighted pipeline', { value: inr(k.weighted ?? 0), sub: 'Open deal value × stage win probability (Process Designer)' }) },
      { l: 'Won · FY', v: inr(k.won_fy), d: `${k.won_fy_n} deals`, dc: 'tok', drill: () => drill('deals', 'won_period', 'Won · FY', { value: inr(k.won_fy), sub: 'Deals won in the selected period' }) },
      { l: 'Win rate', v: `${k.win_rate}%`, drill: () => drill('deals', 'decided', 'Win rate', { value: `${k.win_rate}%` }) },
      { l: 'Avg deal size', v: inr(k.avg_deal), drill: () => drill('deals', 'won', 'Avg deal size', { value: inr(k.avg_deal), sub: 'Average value of won deals' }) },
      { l: 'Avg cycle', v: k.avg_cycle == null ? '—' : `${k.avg_cycle} d`, drill: () => drill('deals', 'won', 'Avg cycle', { value: k.avg_cycle == null ? '—' : `${k.avg_cycle} d`, sub: 'Days from opportunity to win' }) },
    ]} />

    <div className="bw-g g3 mb">
      <Sec t="Pipeline by stage · value">
        <HBars lw={130} vw={84} rows={d.by_stage.map(s => ({ ...s, text: inr(s.v) }))} onPick={i => open(drill('deals', `stage:${d.by_stage[i].l}`, `Stage · ${d.by_stage[i].l}`))} />
      </Sec>
      <Sec t="Deal type">
        <Donut f={v => num(v)} center={num(d.total)} data={d.by_type.map((x, i) => ({ ...x, c: PAL[i] }))} onPick={i => open(drill('deals', `type:${type(i)}`, `${d.by_type[i].l} deals`))} />
      </Sec>
      <Sec t="Forecast category">{d.forecast_available && d.forecast ? <Donut f={v => inr(v)} center={inr(k.open_pipeline)} data={d.forecast.map((x, i) => ({ l: x.l, v: x.v, c: PAL[i] }))} onPick={() => open(drill('deals', 'open', 'Open pipeline', { value: inr(k.open_pipeline) }))} />
        : <Unavailable>{PROB}</Unavailable>}</Sec>
    </div>

    <div className="bw-g g2 mb">
      <Sec t="Won vs lost · 6 months">
        <LineChart h={130} labels={d.months} series={[{ n: 'Won', c: PAL[2], v: d.won_6m }, { n: 'Lost', c: PAL[4], v: d.lost_6m }]} />
      </Sec>
      <Sec t="Win rate by deal type">
        <HBars lw={100} vw={40} rows={d.win_rate_by_type.map(x => ({ l: x.l, v: x.v, text: x.v == null ? '—' : `${x.v}%` }))} onPick={i => open(drill('deals', `type_decided:${type(i)}`, `Win rate · ${d.win_rate_by_type[i].l}`))} />
      </Sec>
    </div>

    <div className="bw-g g2">
      <Sec t="Top open deals" flush>
        {d.top_open.length ? <table className="w-full text-left">
          <thead><tr><th>Deal</th><th className="text-right">Value</th><th>Stage</th><th>Journey</th></tr></thead>
          <tbody>{d.top_open.map(x => <tr key={x.id} className="cursor-pointer" onClick={() => navigate(ROUTE.opp(x.id))}>
            <td><a style={{ color: 'var(--bw-ac)' }}>{x.name}</a></td><td className="text-right tabular-nums">{inr(x.value)}</td><td>{statusPill(x.stage)}</td><td>{x.journey || '—'}</td>
          </tr>)}</tbody>
        </table> : <Empty>No open deals</Empty>}
      </Sec>
      <Sec t="Stalled deals · over 21 days in stage" flush act={<a onClick={() => open(drill('deals', 'stalled', 'Stalled deals · over 21 days in stage'))}>All</a>}>
        {d.stalled.length ? <table className="w-full text-left">
          <thead><tr><th>Deal</th><th>Owner</th><th className="text-right">Days</th></tr></thead>
          <tbody>{d.stalled.map(x => <tr key={x.id} className="cursor-pointer" onClick={() => navigate(ROUTE.opp(x.id))}>
            <td>{x.name}</td><td>{x.owner || '—'}</td><td className="text-right tabular-nums">{x.days_in_stage}</td>
          </tr>)}</tbody>
        </table> : <Empty>No stalled deals</Empty>}
      </Sec>
    </div>
  </>
}
