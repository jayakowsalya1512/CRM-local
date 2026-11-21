import { useNavigate } from 'react-router-dom'
import { Empty, fd, inr, num } from '@/components/platform/bw'
import { Columns, Donut, HBars } from '@/components/platform/charts'
import { usePermissions } from '@/hooks'
import { PERM, monthKeys, useBoard, type Period } from '../data'
import { ROUTE, drill } from '../records'
import { ErrorBox, Kpis, LoadingBox, NoAccess, Sec, Unavailable, statusPill, useDrill } from '../ui'

type Bid = { id: number; num: string; customer: string; value: number; stage: string; manager: string | null; deadline: string; days_left: number; journey: string }
type BidsBoard = {
  kpis: { live: number; due7: number; hit_rate: number; won: number; lost: number; emd_blocked: number; avg_bid: number; pipeline: number }
  by_stage: { l: string; v: number }[]; portals: { l: string; v: number }[]; hit_by_portal: { l: string; v: number | null }[]
  oem: { l: string; v: number; n: number }[]; months: string[]; published_6m: number[]; competitors_available: boolean; deadlines: Bid[]
}

export default function Bids({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const open = useDrill()
  const navigate = useNavigate()
  const r = useBoard<BidsBoard>('bids', period, can(PERM.tenders), nonce)
  if (r.denied) return <NoAccess what="the Bids & Tenders dashboard" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load bids'} />
  const d = r.data, k = d.kpis, keys = monthKeys()

  return <>
    <Kpis items={[
      { l: 'Live bids', v: num(k.live), drill: () => drill('tenders', 'live', 'Live bids', { value: num(k.live) }) },
      { l: 'Due ≤ 7 days', v: num(k.due7), dc: 'twarn', drill: () => drill('tenders', 'due:7', 'Due ≤ 7 days', { value: num(k.due7) }) },
      { l: 'Hit rate', v: `${k.hit_rate}%`, d: `${k.won} won / ${k.lost} lost`, drill: () => drill('tenders', 'decided', 'Hit rate', { value: `${k.hit_rate}%`, breakdown: [{ l: 'Won', v: k.won, text: num(k.won) }, { l: 'Lost', v: k.lost, text: num(k.lost) }] }) },
      { l: 'EMD blocked', v: inr(k.emd_blocked), drill: () => drill('guarantees', 'emd', 'EMD blocked', { value: inr(k.emd_blocked) }) },
      { l: 'Avg bid value', v: inr(k.avg_bid), drill: () => drill('tenders', 'all', 'Avg bid value', { value: inr(k.avg_bid) }) },
      { l: 'Bid pipeline', v: inr(k.pipeline), drill: () => drill('tenders', 'live', 'Bid pipeline', { value: inr(k.pipeline), sub: 'Estimated value of live bids' }) },
    ]} />

    <div className="bw-g g3 mb">
      <Sec t="Bids by stage">
        <HBars lw={120} vw={30} rows={d.by_stage.map(s => ({ ...s, text: num(s.v) }))} onPick={i => open(drill('tenders', `stage:${d.by_stage[i].l}`, `Stage · ${d.by_stage[i].l}`))} />
      </Sec>
      <Sec t="Portal mix">
        <Donut f={v => num(v)} data={d.portals} onPick={i => open(drill('tenders', `portal:${d.portals[i].l}`, `Portal · ${d.portals[i].l}`))} />
      </Sec>
      <Sec t="Hit rate by portal">
        <HBars lw={110} vw={40} rows={d.hit_by_portal.map(p => ({ l: p.l, v: p.v, text: p.v == null ? '—' : `${p.v}%` }))} onPick={i => open(drill('tenders', `portal_decided:${d.hit_by_portal[i].l}`, `Hit rate · ${d.hit_by_portal[i].l}`))} />
      </Sec>
    </div>

    <div className="bw-g g3 mb">
      <Sec t="Bid value by OEM">
        {d.oem.length ? <HBars lw={100} vw={84} rows={d.oem.map(o => ({ l: o.l, v: o.v, text: inr(o.v), note: `${o.n} bid${o.n === 1 ? '' : 's'}` }))} onPick={i => open(drill('tenders', `oem:${d.oem[i].l}`, `OEM · ${d.oem[i].l}`))} />
          : <Empty>No OEMs recorded on bid products</Empty>}
      </Sec>
      <Sec t="Bids published · 6 months">
        <Columns h={120} data={d.published_6m.map((v, i) => ({ l: d.months[i], v }))} onPick={i => open(drill('tenders', `month:${keys[i]}`, `Bids published · ${d.months[i]}`))} />
      </Sec>
      <Sec t="Competitors met">
        <Unavailable>Competitors are kept as a master list but aren't linked to bids yet, so encounters per competitor can't be counted. Record the competitors on each bid to see them here.</Unavailable>
      </Sec>
    </div>

    <Sec t="Submission deadlines · next 14 days" flush act={<a onClick={() => open(drill('tenders', 'due:14', 'Submission deadlines · next 14 days'))}>All</a>}>
      {d.deadlines.length ? <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left">
        <thead><tr><th>Bid</th><th>Customer</th><th className="text-right">Value</th><th>Stage</th><th>Bid manager</th><th>Deadline</th><th>Journey</th></tr></thead>
        <tbody>{d.deadlines.map(t => <tr key={t.id} className="cursor-pointer" onClick={() => navigate(ROUTE.tender(t.id))}>
          <td><a style={{ color: 'var(--bw-ac)' }}>{t.num}</a></td><td>{t.customer}</td><td className="text-right tabular-nums">{inr(t.value)}</td><td>{statusPill(t.stage)}</td><td>{t.manager || '—'}</td>
          <td><span style={{ color: t.days_left <= 3 ? 'var(--bw-ba)' : t.days_left <= 7 ? 'var(--bw-wa)' : undefined, fontWeight: 500 }}>{fd(t.deadline)}</span><small className="ml-1" style={{ color: 'var(--bw-mu)' }}>{t.days_left === 0 ? 'today' : `in ${t.days_left} d`}</small></td>
          <td>{t.journey || '—'}</td>
        </tr>)}</tbody>
      </table></div> : <Empty>No submissions due in the next 14 days</Empty>}
    </Sec>
  </>
}
