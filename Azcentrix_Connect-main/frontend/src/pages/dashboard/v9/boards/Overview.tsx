import { useNavigate } from 'react-router-dom'
import { C, Empty, fd, inr, num } from '@/components/platform/bw'
import { Donut, HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, pct, useBoard, type Period } from '../data'
import { ROUTE, drill } from '../records'
import { ErrorBox, Kpis, LoadingBox, PickFunnel, Sec, statusPill, useDrill } from '../ui'

type Overview = {
  kpis: { booked: number; target: number; booked_spark: number[]; open_pipeline: number; win_rate: number; won: number; lost: number; active_orders: number; receivables: number; invoices: number; guarantees_blocked: number; approvals_pending: number }
  journey: { l: string; v: number }[]
  months: string[]; bookings: number[]; billing: number[]; has_invoices: boolean
  pipeline_by_stage: { l: string; v: number }[]
  attention: { sev: 'crit' | 'warn'; text: string; kind: 'tender' | 'guarantee' | 'approval'; id: number | string }[]
  top_customers: { l: string; v: number }[]
  winloss: { won: number; lost: number; open: number }
  approvals: { id: string; title: string; by: string | null; value: number; status: string }[]
  recent: { id: number; type: string; customer: string; kam: string; date: string }[]
}

// Sales journey stage → the records behind it.
const JOURNEY = [['leads', 'all'], ['leads', 'converted'], ['deals', 'all'], ['tenders', 'all'], ['tenders', 'won'], ['orders', 'all'], ['orders', 'follow_on']] as const

export default function Overview({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const navigate = useNavigate()
  const r = useBoard<Overview>('overview', period, can(PERM.base), nonce)
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load the overview'} />
  const d = r.data, k = d.kpis
  const att = (a: Overview['attention'][number]) => a.kind === 'tender' ? navigate(ROUTE.tender(Number(a.id))) : a.kind === 'guarantee' ? navigate(ROUTE.emd) : navigate(ROUTE.approvals)

  return <>
    <Kpis items={[
      { l: 'Revenue booked', v: inr(k.booked), d: k.target ? `${pct(k.booked, k.target)}% of target` : undefined, dc: 'tok', sp: k.booked_spark,
        drill: () => drill('tenders', 'booked', 'Revenue booked', { value: inr(k.booked), sub: `Won bids in the period${k.target ? ` · target ${inr(k.target)}` : ''}` }) },
      { l: 'Open pipeline', v: inr(k.open_pipeline), drill: () => drill('deals', 'open', 'Open pipeline', { value: inr(k.open_pipeline), sub: 'Open opportunities' }) },
      { l: 'Win rate', v: `${k.win_rate}%`, drill: () => drill('deals', 'decided', 'Win rate', { value: `${k.win_rate}%`, sub: `${k.won} won / ${k.lost} lost`, breakdown: [{ l: 'Won', v: k.won, text: num(k.won) }, { l: 'Lost', v: k.lost, text: num(k.lost) }] }) },
      { l: 'Active orders', v: num(k.active_orders), drill: () => drill('orders', 'active', 'Active orders', { value: num(k.active_orders) }) },
      { l: 'Receivables', v: inr(k.receivables), dc: 'twarn', d: 'payment stages due to date',
        drill: () => drill('payments', 'outstanding', 'Receivables', { value: inr(k.receivables), sub: 'Unpaid balance of payment stages due on or before today (Collections & finance)' }) },
      { l: 'Guarantees blocked', v: inr(k.guarantees_blocked), drill: () => drill('guarantees', 'active', 'Guarantees blocked', { value: inr(k.guarantees_blocked) }) },
      { l: 'Approvals pending', v: num(k.approvals_pending), drill: () => drill('approvals', 'all', 'Approvals pending', { value: num(k.approvals_pending) }) },
    ]} />

    <div className="bw-g g3 mb">
      <Sec t="Sales journey · lead to order">
        <PickFunnel data={d.journey} onPick={i => open(drill(JOURNEY[i][0], JOURNEY[i][1], `Sales journey · ${d.journey[i].l}`, { value: num(d.journey[i].v) }))} />
      </Sec>
      <Sec t="Bookings vs billing · 6 months">
        <LineChart h={130} labels={d.months} series={[{ n: 'Bookings (₹ L)', c: PAL[0], v: d.bookings }, { n: 'Billing (₹ L)', c: PAL[2], v: d.billing }]} />
        {!d.has_invoices && <p className="mt-1 text-[11.5px]" style={{ color: C.mu }}>No invoices recorded yet — billing appears once invoices are added to work orders.</p>}      </Sec>
      <Sec t="Open pipeline by stage">
        <HBars lw={120} vw={84} rows={d.pipeline_by_stage.map(s => ({ ...s, text: inr(s.v) }))} onPick={i => open(drill('deals', `stage:${d.pipeline_by_stage[i].l}`, `Open pipeline · ${d.pipeline_by_stage[i].l}`))} />
      </Sec>
    </div>

    <div className="bw-g g3 mb">
      <Sec t="Needs attention" flush>
        {d.attention.length ? <div className="bw-list">{d.attention.map((a, i) => <div key={i}>
          <span className="h-2 w-2 flex-none rounded-full" style={{ background: a.sev === 'crit' ? C.ba : C.wa }} />
          <span className="min-w-0 flex-1">{a.text}</span>
          <a className="cursor-pointer font-medium" style={{ color: C.ac }} onClick={() => att(a)}>Open</a>
        </div>)}</div> : <Empty>Nothing needs attention</Empty>}
      </Sec>
      <Sec t="Top customers · FY revenue">
        {d.top_customers.length ? <HBars lw={130} vw={84} rows={d.top_customers.map(c => ({ ...c, text: inr(c.v) }))} onPick={i => open(drill('tenders', `customer_won:${d.top_customers[i].l}`, `Revenue · ${d.top_customers[i].l}`))} />
          : <Empty>No won bids in this period</Empty>}
      </Sec>
      <Sec t="Win / loss">
        <Donut f={v => num(v)} center={`${k.win_rate}%`} data={[{ l: 'Won', v: d.winloss.won, c: 'var(--bw-ok)' }, { l: 'Lost', v: d.winloss.lost, c: 'var(--bw-ba)' }, { l: 'Open', v: d.winloss.open, c: 'var(--bw-ln2)' }]}
          onPick={i => open(drill('deals', ['won', 'lost', 'open'][i], ['Won deals', 'Lost deals', 'Open deals'][i]))} />
      </Sec>
    </div>

    <div className="bw-g g2">
      <Sec t="Pending approvals" flush act={<a onClick={() => navigate(ROUTE.approvals)}>All</a>}>
        {d.approvals.length ? <div className="overflow-x-auto"><table className="w-full text-left">
          <thead><tr><th>Request</th><th>By</th><th className="text-right">Value</th><th>Status</th></tr></thead>
          <tbody>{d.approvals.map(a => <tr key={a.id} className="cursor-pointer" onClick={() => navigate(ROUTE.approvals)}>
            <td>{a.title}</td><td>{a.by || '—'}</td><td className="text-right tabular-nums">{a.value ? inr(a.value) : '—'}</td><td>{statusPill(a.status)}</td>
          </tr>)}</tbody>
        </table></div> : <Empty>All caught up</Empty>}
      </Sec>
      <Sec t="Recent activity" act={<a onClick={() => open(drill('activities', 'all', 'Recent activity · 14 days'))}>All</a>}>
        {d.recent.length ? <div className="bwd-tl">{d.recent.map(a => <div key={a.id}>
          <b>{a.type}{a.customer ? ` – ${a.customer}` : ''}</b><br /><small style={{ color: C.mu }}>{a.kam} · {fd(a.date)}</small>
        </div>)}</div> : <Empty>No activity logged yet</Empty>}
      </Sec>
    </div>
  </>
}
