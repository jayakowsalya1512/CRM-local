import type { FC, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, Empty, Pill, fd, inr, num } from '@/components/platform/bw'
import { Donut, HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, daysFromToday, useBoard, useWelcome, type BoardKey, type LayoutWidget, type Period } from './data'
import { ROUTE, drill } from './records'
import { Kpis, NoAccess, PickFunnel, Unavailable, statusPill, useDrill } from './ui'

// Widget catalogue for custom dashboards (prototype WID). Each widget reads a board payload (requests are shared,
// so several widgets on one dashboard cost one call per board) and respects that board's permission.
type WProps = { period: Period; nonce: number }
export type WidgetDef = { t: string; s: 1 | 2 | 3; flush?: boolean; C: FC<WProps> }

const PERM_OF: Record<BoardKey, string> = { overview: PERM.base, leads: PERM.leads, deals: PERM.deals, bids: PERM.tenders, funnel: PERM.base, kam: PERM.kam, orders: PERM.orders, finance: PERM.finance, login: PERM.login }
function Board<T>({ board, period, nonce, what, children }: WProps & { board: BoardKey; what: string; children: (d: T) => ReactNode }) {
  const { can } = usePermissions()
  const r = useBoard<T>(board, period, can(PERM_OF[board]), nonce)
  if (r.denied) return <NoAccess what={what} />
  if (r.loading) return <Empty>Loading…</Empty>
  if (r.error || !r.data) return <Empty>{r.error || 'Could not load data'}</Empty>
  return <>{children(r.data)}</>
}

const KeyMetrics: FC<WProps> = p => {
  const { can } = usePermissions()
  const bids = useBoard<any>('bids', p.period, can(PERM.tenders), p.nonce).data
  return <Board<any> {...p} board="overview" what="the overview">{o => {
  const k = o.kpis
  return <Kpis items={[
    { l: 'Open pipeline', v: inr(k.open_pipeline), drill: () => drill('deals', 'open', 'Open pipeline', { value: inr(k.open_pipeline) }) },
    { l: 'Live bids', v: bids ? num(bids.kpis.live) : '—', d: bids ? `${bids.kpis.due7} due this week` : undefined, dc: 'twarn', drill: () => drill('tenders', 'live', 'Live bids') },
    { l: 'Win rate (FY)', v: `${k.win_rate}%`, drill: () => drill('deals', 'decided', 'Win rate (FY)', { value: `${k.win_rate}%` }) },
    { l: 'Guarantees blocked', v: inr(k.guarantees_blocked), drill: () => drill('guarantees', 'active', 'Guarantees blocked', { value: inr(k.guarantees_blocked) }) },
    { l: 'Pending approvals', v: num(k.approvals_pending), dc: k.approvals_pending ? 'tbad' : undefined, drill: () => drill('approvals', 'all', 'Pending approvals') },
    { l: 'Orders running', v: num(k.active_orders), drill: () => drill('orders', 'active', 'Orders running') },
  ]} />
  }}</Board>
}

const Comparison: FC<WProps> = () => <Unavailable>Company comparison appears in a parent-group view. This workspace is a single company.</Unavailable>

const PipeByStage: FC<WProps> = p => { const open = useDrill(); return <Board<any> {...p} board="overview" what="the overview">{o =>
  <HBars lw={140} vw={84} rows={o.pipeline_by_stage.map((s: any) => ({ ...s, text: inr(s.v) }))} onPick={i => open(drill('deals', `stage:${o.pipeline_by_stage[i].l}`, `Stage · ${o.pipeline_by_stage[i].l}`))} />}</Board> }

const Deadlines: FC<WProps> = p => { const navigate = useNavigate(); return <Board<any> {...p} board="bids" what="bids">{b =>
  b.deadlines.length ? <table className="w-full text-left">
    <thead><tr><th>Bid</th><th>Customer</th><th className="text-right">Value</th><th>Stage</th><th>Due</th></tr></thead>
    <tbody>{b.deadlines.slice(0, 7).map((t: any) => <tr key={t.id} className="cursor-pointer" onClick={() => navigate(ROUTE.tender(t.id))}>
      <td><b>{t.num}</b></td><td>{t.customer}</td><td className="text-right tabular-nums">{inr(t.value)}</td><td>{statusPill(t.stage)}</td><td>{fd(t.deadline)}</td>
    </tr>)}</tbody>
  </table> : <Empty>No submissions due in the next 14 days</Empty>}</Board> }

const SubmittedVsWon: FC<WProps> = p => <Board<any> {...p} board="bids" what="bids">{b =>
  <LineChart h={130} labels={b.months} series={[{ n: 'Submitted', c: PAL[0], v: b.published_6m }, { n: 'Won', c: PAL[2], v: b.won_6m }, { n: 'Lost', c: PAL[4], v: b.lost_6m }]} />}</Board>

const Tasks: FC<WProps> = ({ nonce }) => {
  const navigate = useNavigate()
  const w = useWelcome(nonce).data as any
  const tasks: any[] = w?.tasks ?? []
  return tasks.length ? <div className="bw-list">{tasks.map(t => { const d = daysFromToday(t.due); return <div key={t.id} className="cursor-pointer" onClick={() => navigate(ROUTE.kam)}>
    <span className="min-w-0 flex-1">{t.title}<br /><small style={{ color: 'var(--bw-mu)' }}>{t.customer || t.priority}</small></span>
    {d != null && <Pill t={d < 0 ? 'ba' : d <= 2 ? 'wa' : 'mu'}>{d === 0 ? 'Today' : d < 0 ? `${-d} d late` : `In ${d} d`}</Pill>}
  </div> })}</div> : <Empty>All clear</Empty>
}

const ApprovalsWaiting: FC<WProps> = p => { const navigate = useNavigate(); return <Board<any> {...p} board="overview" what="approvals">{o =>
  o.approvals.length ? <div className="bw-list">{o.approvals.slice(0, 4).map((a: any) => <div key={a.id} className="cursor-pointer" onClick={() => navigate(ROUTE.approvals)}>
    <span className="min-w-0 flex-1"><b>{a.title}</b><br /><small style={{ color: 'var(--bw-mu)' }}>{a.by || '—'}{a.value ? ` · ${inr(a.value)}` : ''}</small></span>{statusPill(a.status)}
  </div>)}</div> : <Empty>Nothing pending</Empty>}</Board> }

const GuaranteesExpiring: FC<WProps> = p => { const open = useDrill(); return <Board<any> {...p} board="finance" what="guarantees">{f => {
  const rows = f.expiring.filter((g: any) => g.days_left <= 45).slice(0, 4)
  return rows.length ? <div className="bw-list">{rows.map((g: any) => <div key={g.id} className="cursor-pointer" onClick={() => open(drill('guarantees', `id:${g.id}`, `${g.type} ${g.ref}`, { value: inr(g.amount) }))}>
    <span className="min-w-0 flex-1"><b>{g.type} {g.ref}</b><br /><small style={{ color: 'var(--bw-mu)' }}>{g.customer} · {inr(g.amount)}</small></span><small>{fd(g.valid_until)}</small>
  </div>)}</div> : <Empty>None expiring</Empty>
}}</Board> }

const RecentActivity: FC<WProps> = p => <Board<any> {...p} board="overview" what="activity">{o =>
  o.recent.length ? <div className="bwd-tl">{o.recent.map((a: any) => <div key={a.id}><b>{a.kam}</b> · {a.type}<br /><small style={{ color: 'var(--bw-mu)' }}>{a.customer} · {fd(a.date)}</small></div>)}</div> : <Empty>No activity logged yet</Empty>}</Board>

const LeadFunnel: FC<WProps> = p => { const open = useDrill(); return <Board<any> {...p} board="leads" what="leads">{l =>
  <PickFunnel data={l.funnel} onPick={i => open(drill('leads', l.funnel[i].l === 'Converted' ? 'converted' : `status:${l.funnel[i].l}`, `Stage · ${l.funnel[i].l}`))} />}</Board> }

const TopAccounts: FC<WProps> = p => { const open = useDrill(); return <Board<any> {...p} board="overview" what="the overview">{o =>
  o.top_customers.length ? <HBars lw={110} vw={70} rows={o.top_customers.map((c: any) => ({ ...c, text: inr(c.v) }))} onPick={i => open(drill('tenders', `customer_won:${o.top_customers[i].l}`, `Revenue · ${o.top_customers[i].l}`))} /> : <Empty>No won bids in this period</Empty>}</Board> }

const Leaderboard: FC<WProps> = p => { const navigate = useNavigate(); return <Board<any> {...p} board="kam" what="KAM performance">{k =>
  k.kams.length ? <table className="w-full text-left"><thead><tr><th>KAM</th><th>Target</th></tr></thead>
    <tbody>{k.kams.slice(0, 5).map((x: any) => <tr key={x.id} className="cursor-pointer" onClick={() => navigate(ROUTE.kam360(x.id))}>
      <td>{x.name}</td><td style={{ minWidth: 120 }}>{x.achieved_pct == null ? '—' : <Bar value={x.achieved_pct} />}</td>
    </tr>)}</tbody></table> : <Empty>No KAMs</Empty>}</Board> }

const Forecast: FC<WProps> = () => <Unavailable>Win probabilities are not configured for the opportunity stages, so a forecast can't be calculated yet.</Unavailable>

const QuotesByStage: FC<WProps> = p => <Board<any> {...p} board="overview" what="quotations">{o =>
  o.quotes_by_stage?.length ? <Donut f={v => num(v)} data={o.quotes_by_stage} /> : <Empty>No quotations</Empty>}</Board>

const OrderProgress: FC<WProps> = p => { const open = useDrill(); return <Board<any> {...p} board="orders" what="orders">{w =>
  w.progress_list.length ? <HBars lw={150} vw={40} rows={w.progress_list.map((o: any) => ({ l: o.title, v: o.progress, text: `${o.progress}%` }))}
    onPick={i => open(drill('orders', `id:${w.progress_list[i].id}`, w.progress_list[i].title))} /> : <Empty>No active orders</Empty>}</Board> }

const WinLoss: FC<WProps> = p => { const open = useDrill(); return <Board<any> {...p} board="overview" what="the overview">{o =>
  <Donut f={v => num(v)} data={[{ l: 'Won', v: o.winloss.won, c: 'var(--bw-ok)' }, { l: 'Lost', v: o.winloss.lost, c: 'var(--bw-ba)' }, { l: 'Open', v: o.winloss.open, c: 'var(--bw-ln)' }]}
    onPick={i => open(drill('deals', ['won', 'lost', 'open'][i], ['Won deals', 'Lost deals', 'Open deals'][i]))} />}</Board> }

const Competitors: FC<WProps> = () => <Unavailable>Competitors aren't linked to bids yet, so encounters can't be counted.</Unavailable>

export const WID: Record<string, WidgetDef> = {
  kpi: { t: 'Key metrics', s: 3, C: KeyMetrics },
  cmp: { t: 'Company comparison', s: 3, C: Comparison },
  pipe: { t: 'Pipeline by stage', s: 2, C: PipeByStage },
  due: { t: 'Bid submission deadlines', s: 2, flush: true, C: Deadlines },
  trend: { t: 'Submitted vs won', s: 2, C: SubmittedVsWon },
  tasks: { t: 'My tasks', s: 1, flush: true, C: Tasks },
  appr: { t: 'Approvals waiting', s: 1, flush: true, C: ApprovalsWaiting },
  emd: { t: 'Guarantees expiring ≤ 45 days', s: 1, flush: true, C: GuaranteesExpiring },
  feed: { t: 'Recent activity', s: 1, C: RecentActivity },
  funnel: { t: 'Lead funnel', s: 1, C: LeadFunnel },
  top: { t: 'Top accounts by revenue', s: 1, C: TopAccounts },
  lb: { t: 'KAM leaderboard', s: 1, flush: true, C: Leaderboard },
  fc: { t: 'Forecast outlook', s: 2, C: Forecast },
  qage: { t: 'Quotes by stage', s: 1, C: QuotesByStage },
  ord: { t: 'Order progress', s: 2, C: OrderProgress },
  win: { t: 'Win / loss', s: 1, C: WinLoss },
  comp: { t: 'Competitor encounters', s: 1, C: Competitors },
}

// Prototype dClone(): "Save as my dashboard" starts from these widgets; "New dashboard" starts with Key metrics only.
export const CLONE_WIDGETS: LayoutWidget[] = [{ id: 'kpi', s: 3 }, { id: 'pipe', s: 2 }, { id: 'due', s: 2 }, { id: 'tasks', s: 1 }, { id: 'appr', s: 1 }]
export const NEW_WIDGETS: LayoutWidget[] = [{ id: 'kpi', s: 3 }]
