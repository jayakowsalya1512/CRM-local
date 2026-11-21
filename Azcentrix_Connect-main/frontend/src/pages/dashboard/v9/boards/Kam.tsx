import { useNavigate } from 'react-router-dom'
import { Bar, Empty, inr, num } from '@/components/platform/bw'
import { Donut, HBars, Heat } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, useBoard, type Period } from '../data'
import { ROUTE, drill } from '../records'
import { ErrorBox, Kpis, LoadingBox, NoAccess, Sec, useDrill } from '../ui'

type KamRow = { id: number; name: string; target: number; achieved: number; achieved_pct: number | null; pipeline: number; activities: number; visits: number; win_rate: number | null; customers: number }
type KamBoard = { kpis: { target: number; achieved: number; pipeline: number; activities: number; visits: number; kams: number }; kams: KamRow[]; activity_mix: { l: string; v: number }[]; days: string[]; heat: number[][] }

const first = (n: string) => n.split(' ')[0]
const NONE = 'No account managers fall within your dashboard data visibility'

export default function Kam({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const navigate = useNavigate()
  const r = useBoard<KamBoard>('kam', period, can(PERM.kam), nonce)
  if (r.denied) return <NoAccess what="the KAM performance dashboard" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load KAM performance'} />
  const d = r.data, k = d.kpis, K = d.kams
  // Charts label KAMs by first name (as the prototype does) unless two KAMs share it.
  const dup = new Set(K.map(x => first(x.name)).filter((f, i, a) => a.indexOf(f) !== i))
  const short = (x: KamRow) => (dup.has(first(x.name)) ? x.name : first(x.name))
  const pick = (x: KamRow) => navigate(ROUTE.kam360(x.id))
  const byPipe = K.slice().sort((a, b) => b.pipeline - a.pipeline)
  const withTarget = K.filter(x => x.target > 0)

  return <>
    <Kpis items={[
      { l: 'Team target', v: inr(k.target), drill: () => drill('kams', 'all', 'Team target', { value: inr(k.target), breakdown: withTarget.map(x => ({ l: x.name, v: x.target, text: inr(x.target) })) }) },
      { l: 'Achieved', v: inr(k.achieved), d: k.target ? `${Math.round(k.achieved / k.target * 100)}%` : undefined, dc: 'tok', drill: () => drill('kams', 'all', 'Achieved', { value: inr(k.achieved) }) },
      { l: 'Pipeline', v: inr(k.pipeline), drill: () => drill('kams', 'all', 'Pipeline', { value: inr(k.pipeline), breakdown: byPipe.filter(x => x.pipeline).map(x => ({ l: x.name, v: x.pipeline, text: inr(x.pipeline) })) }) },
      { l: 'Activities · 14d', v: num(k.activities), drill: () => drill('activities', 'all', 'Activities · 14d', { value: num(k.activities) }) },
      { l: 'Site visits', v: num(k.visits), drill: () => drill('activities', 'visits', 'Site visits · 14d', { value: num(k.visits) }) },
      { l: 'KAMs', v: num(k.kams), drill: () => drill('kams', 'all', 'KAMs', { value: num(k.kams) }) },
    ]} />

    {/* prototype dashK: the five panels are always shown; each says so when there is nothing to plot */}
    <>
      <div className="bw-g g2 mb">
        <Sec t="Target vs achieved">
          {!K.length ? <Empty>{NONE}</Empty> : withTarget.length ? <HBars lw={90} vw={44} rows={withTarget.map(x => { const v = x.achieved_pct ?? 0, f = x.achieved / x.target; return { l: short(x), v, text: `${v}%`, c: f > .7 ? 'var(--bw-ok)' : f > .45 ? 'var(--bw-wa)' : 'var(--bw-ba)' } })}
            onPick={i => pick(withTarget[i])} /> : <Empty>No sales targets set for this year</Empty>}
        </Sec>
        <Sec t="Activity mix">
          {d.activity_mix.length ? <Donut f={v => num(v)} data={d.activity_mix} onPick={i => open(drill('activities', `type:${d.activity_mix[i].l}`, `Activity · ${d.activity_mix[i].l}`))} /> : <Empty>No activities in the last 14 days</Empty>}
        </Sec>
      </div>

      <div className="bw-g g2 mb">
        <Sec t="Activity heat-map · last 7 days">
          {!K.length ? <Empty>{NONE}</Empty> : <Heat rows={K.map(short)} cols={d.days.map(x => x.slice(8))} cell={(i, j) => { const n = d.heat[i]?.[j] ?? 0; return { v: n ? Math.min(100, n * 35 + 8) : 0, t: `${K[i].name} · ${d.days[j]}: ${n} activit${n === 1 ? 'y' : 'ies'}` } }} />}
        </Sec>
        <Sec t="Pipeline per KAM">
          {!K.length ? <Empty>{NONE}</Empty> : <HBars lw={90} vw={84} rows={byPipe.map(x => ({ l: short(x), v: x.pipeline, text: inr(x.pipeline) }))} onPick={i => pick(byPipe[i])} />}
        </Sec>
      </div>

      <Sec t="KAM leaderboard" flush>
        {!K.length ? <Empty>{NONE}</Empty> : <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left">
          <thead><tr><th>KAM</th><th>Target achieved</th><th className="text-right">Pipeline</th><th className="text-right">Activities</th><th className="text-right">Visits</th><th>Win rate</th><th className="text-right">Customers</th></tr></thead>
          <tbody>{K.map(x => <tr key={x.id} className="cursor-pointer" title={`Open ${x.name} in KAM 360`} onClick={() => pick(x)}>
            <td><b>{x.name}</b></td><td style={{ minWidth: 150 }}>{x.achieved_pct == null ? <span style={{ color: 'var(--bw-mu)' }}>No target</span> : <Bar value={x.achieved_pct} />}</td>
            <td className="text-right tabular-nums">{inr(x.pipeline)}</td><td className="text-right tabular-nums">{num(x.activities)}</td><td className="text-right tabular-nums">{num(x.visits)}</td>
            <td>{x.win_rate == null ? '—' : `${x.win_rate}%`}</td><td className="text-right tabular-nums">{num(x.customers)}</td>
          </tr>)}</tbody>
        </table></div>}
      </Sec>
    </>
  </>
}
