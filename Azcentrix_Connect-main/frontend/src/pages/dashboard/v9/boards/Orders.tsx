import { Bar, Empty, fd, inr, num } from '@/components/platform/bw'
import { Columns, Donut, HBars } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, daysFromToday, useBoard, type Period } from '../data'
import { drill } from '../records'
import { ErrorBox, Kpis, LoadingBox, NoAccess, Sec, useDrill } from '../ui'

type Order = { id: number; number: string; title: string; progress: number; gap: number; due: string; pm: string | null }
type OrdersBoard = {
  kpis: { active: number; value: number; avg_progress: number; billed_pct: number; delayed: number; contracts: number }
  by_type: { l: string; v: number }[]; by_stage: { l: string; v: number }[]; progress: { l: string; v: number; lo: number; hi: number }[]
  gap: Order[]; due_soon: Order[]
}

export default function Orders({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const r = useBoard<OrdersBoard>('orders', period, can(PERM.orders), nonce)
  if (r.denied) return <NoAccess what="the Orders & delivery dashboard" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load orders'} />
  const d = r.data, k = d.kpis
  const one = (o: Order) => open(drill('orders', `id:${o.id}`, o.title, { sub: o.number }))

  return <>
    <Kpis items={[
      { l: 'Active orders', v: num(k.active), drill: () => drill('orders', 'active', 'Active orders', { value: num(k.active) }) },
      { l: 'Order value', v: inr(k.value), drill: () => drill('orders', 'all', 'Order value', { value: inr(k.value) }) },
      { l: 'Avg progress', v: `${k.avg_progress}%`, drill: () => drill('orders', 'active', 'Avg progress', { value: `${k.avg_progress}%`, sub: 'Average progress of active orders' }) },
      { l: 'Billed', v: `${k.billed_pct}%`, drill: () => drill('orders', 'billed', 'Billed', { value: `${k.billed_pct}%`, sub: 'Invoiced value as a share of order value' }) },
      { l: 'Delayed', v: num(k.delayed), dc: 'tbad', drill: () => drill('orders', 'delayed', 'Delayed', { value: num(k.delayed), sub: 'Active orders past their delivery date' }) },
      { l: 'Contracts (AMC etc.)', v: num(k.contracts), drill: () => drill('orders', 'follow_on', 'Contracts (AMC etc.)', { value: num(k.contracts) }) },
    ]} />

    <div className="bw-g g3 mb">
      <Sec t="By contract type">
        {d.by_type.length ? <Donut f={v => num(v)} data={d.by_type} onPick={i => open(drill('orders', `type:${d.by_type[i].l}`, `Contract type · ${d.by_type[i].l}`))} /> : <Empty>No orders</Empty>}
      </Sec>
      <Sec t="Orders by stage">
        <HBars lw={110} vw={30} rows={d.by_stage.map(s => ({ ...s, text: num(s.v) }))} onPick={i => open(drill('orders', `stage:${d.by_stage[i].l}`, `Stage · ${d.by_stage[i].l}`))} />
      </Sec>
      <Sec t="Progress distribution">
        <Columns h={120} data={d.progress.map(p => ({ l: p.l, v: p.v }))} onPick={i => open(drill('orders', `progress:${d.progress[i].lo}-${d.progress[i].hi}`, `Progress ${d.progress[i].l}%`))} />
      </Sec>
    </div>

    <div className="bw-g g2">
      <Sec t="Billing gap · work done but not invoiced">
        {d.gap.length ? <HBars lw={110} vw={44} rows={d.gap.map(o => ({ l: o.number, v: o.gap, text: `${o.gap} pts`, note: o.title }))} onPick={i => one(d.gap[i])} />
          : <Empty>No billing gap on active orders</Empty>}
      </Sec>
      <Sec t="Delayed / due soon" flush act={<a onClick={() => open(drill('orders', 'due_soon', 'Delayed / due soon'))}>All</a>}>
        {d.due_soon.length ? <table className="w-full text-left">
          <thead><tr><th>Order</th><th>Progress</th><th>Due</th><th>PM</th></tr></thead>
          <tbody>{d.due_soon.map(o => { const n = daysFromToday(o.due) ?? 0; return <tr key={o.id} className="cursor-pointer" onClick={() => one(o)}>
            <td><a style={{ color: 'var(--bw-ac)' }}>{o.title}</a></td><td style={{ minWidth: 130 }}><Bar value={o.progress} /></td>
            <td><span style={{ color: n < 0 ? 'var(--bw-ba)' : n <= 7 ? 'var(--bw-wa)' : undefined, fontWeight: 500 }}>{fd(o.due)}</span><small className="ml-1" style={{ color: 'var(--bw-mu)' }}>{n < 0 ? `${-n} d late` : n === 0 ? 'today' : `in ${n} d`}</small></td>
            <td>{o.pm || '—'}</td>
          </tr> })}</tbody>
        </table> : <Empty>Nothing due soon</Empty>}
      </Sec>
    </div>
  </>
}
