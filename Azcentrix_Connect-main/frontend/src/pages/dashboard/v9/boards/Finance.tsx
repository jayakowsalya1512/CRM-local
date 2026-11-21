import { Empty, fd, inr, num } from '@/components/platform/bw'
import { Donut, HBars, LineChart, PAL } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, useBoard, type Period } from '../data'
import { drill } from '../records'
import { ErrorBox, Kpis, LoadingBox, NoAccess, Sec, Unavailable, useDrill } from '../ui'

type G = { id: number; ref: string; type: string; customer: string; amount: number; valid_until: string; days_left: number }
type FinanceBoard = {
  kpis: { billed: number; collected: number; collected_n: number; awaiting: number; awaiting_n: number; outstanding: number; over_90: number; guarantees: number; expiring_30: number }
  has_invoices: boolean; invoice_count: number; has_schedule: boolean; receipt_count: number
  ageing: { l: string; v: number }[]; by_customer: { l: string; v: number }[]; guarantee_types: { l: string; v: number }[]
  months: string[]; billed_6m: number[]; collected_6m: number[]; expiring: G[]
}

const AGE_COLORS = ['var(--bw-ok)', PAL[0], 'var(--bw-wa)', 'var(--bw-ba)']
const NO_SCH = 'No orders with a payment schedule are in scope yet. Receivables appear here once orders exist in Orders & Projects.'

// Finance (prototype dashF). Billed = invoices raised. Collected / awaiting finance / outstanding / ageing come from the
// Orders & Projects payment ledger – the same receipts and payment stages as Collections & finance (never an estimate).
export default function Finance({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const r = useBoard<FinanceBoard>('finance', period, can(PERM.finance), nonce)
  if (r.denied) return <NoAccess what="the Finance dashboard" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load finance'} />
  const d = r.data, k = d.kpis, inv = d.has_invoices, sch = d.has_schedule

  return <>
    <Kpis items={[
      { l: 'Billed', v: inv ? inr(k.billed) : '—', d: inv ? `${num(d.invoice_count)} invoices` : 'No invoices recorded', drill: () => drill('invoices', 'billed_period', 'Billed', { value: inr(k.billed), sub: 'Invoices raised in the period' }) },
      { l: 'Collected', v: inr(k.collected), dc: 'tok', d: `${num(k.collected_n)} receipts · Finance-acknowledged`, drill: () => drill('receipts', 'collected_period', 'Collected', { value: inr(k.collected), sub: 'Receipts acknowledged by Finance, by bank credit date in the period' }) },
      { l: 'Awaiting finance', v: inr(k.awaiting), dc: k.awaiting_n ? 'twarn' : undefined, d: `${num(k.awaiting_n)} receipts`, drill: () => drill('receipts', 'awaiting', 'Awaiting finance', { value: inr(k.awaiting), sub: 'Recorded by Sales, not yet acknowledged by Finance' }) },
      { l: 'Outstanding', v: inr(k.outstanding), dc: 'twarn', d: 'payment stages due to date', drill: () => drill('payments', 'outstanding', 'Outstanding', { value: inr(k.outstanding), sub: 'Unpaid balance of payment stages due on or before today' }) },
      { l: 'Over 90 days', v: inr(k.over_90), dc: 'tbad', drill: () => drill('payments', 'over_90', 'Over 90 days', { value: inr(k.over_90), sub: 'Balance of stages more than 90 days past their due date' }) },
      { l: 'Guarantees blocked', v: inr(k.guarantees), drill: () => drill('guarantees', 'active', 'Guarantees blocked', { value: inr(k.guarantees) }) },
      { l: 'Expiring ≤ 30 d', v: num(k.expiring_30), dc: 'twarn', drill: () => drill('guarantees', 'expiring:30', 'Expiring ≤ 30 d', { value: num(k.expiring_30) }) },
    ]} />

    <div className="bw-g g3 mb">
      <Sec t="Receivable ageing">
        {sch ? <Donut f={inr} center={inr(d.ageing.reduce((a, b) => a + b.v, 0))} data={d.ageing.map((a, i) => ({ ...a, c: AGE_COLORS[i] }))}
          onPick={i => open(drill('payments', `age:${d.ageing[i].l}`, `Receivable ageing · ${d.ageing[i].l}`))} /> : <Unavailable>{NO_SCH}</Unavailable>}
      </Sec>
      <Sec t="Outstanding by customer">
        {!sch ? <Unavailable>{NO_SCH}</Unavailable> : d.by_customer.length ? <HBars lw={120} vw={84} rows={d.by_customer.map(c => ({ ...c, text: inr(c.v) }))}
          onPick={i => open(drill('payments', `customer:${d.by_customer[i].l}`, `Outstanding · ${d.by_customer[i].l}`))} /> : <Empty>Nothing outstanding</Empty>}
      </Sec>
      <Sec t="Guarantees by type">
        {d.guarantee_types.length ? <Donut f={inr} data={d.guarantee_types} onPick={i => open(drill('guarantees', `type:${d.guarantee_types[i].l}`, `Guarantees · ${d.guarantee_types[i].l}`))} /> : <Empty>No active guarantees</Empty>}
      </Sec>
    </div>

    <div className="bw-g g2">
      <Sec t="Billing vs collection · 6 months">
        {inv || d.receipt_count ? <LineChart h={130} labels={d.months} series={[{ n: 'Billed (₹ L)', c: PAL[0], v: d.billed_6m }, { n: 'Collected (₹ L)', c: PAL[2], v: d.collected_6m }]} /> : <Unavailable>No invoices or acknowledged receipts yet.</Unavailable>}
      </Sec>
      <Sec t="Guarantees expiring soon" flush act={<a onClick={() => open(drill('guarantees', 'expiring:60', 'Guarantees expiring · 60 days'))}>All</a>}>
        {d.expiring.length ? <table className="w-full text-left">
          <thead><tr><th>Type</th><th>Ref</th><th>Customer</th><th className="text-right">Amount</th><th>Valid until</th></tr></thead>
          <tbody>{d.expiring.map(g => <tr key={g.id} className="cursor-pointer" onClick={() => open(drill('guarantees', `id:${g.id}`, `${g.type} ${g.ref}`, { value: inr(g.amount) }))}>
            <td>{g.type}</td><td>{g.ref}</td><td>{g.customer}</td><td className="text-right tabular-nums">{inr(g.amount)}</td>
            <td><span style={{ color: g.days_left <= 7 ? 'var(--bw-ba)' : g.days_left <= 30 ? 'var(--bw-wa)' : undefined, fontWeight: 500 }}>{fd(g.valid_until)}</span></td>
          </tr>)}</tbody>
        </table> : <Empty>No guarantees expiring in 60 days</Empty>}
      </Sec>
    </div>
  </>
}
