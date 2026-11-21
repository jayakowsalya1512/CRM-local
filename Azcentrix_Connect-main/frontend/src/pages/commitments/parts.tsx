// Prototype v18 commitment building blocks shared by Dashboard → Commitments and Field Sales 360 → Commitments:
// cmWkBar(), cmKpis(), cmMatrix(), cmCell(), cmScore(), mbar() / mbarP(), pbars(), heat(), cmTenH() and the payment table.
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { Av, Pill, Tbl } from '@/pages/customers/kit'
import { inr } from '@/pages/customers/customerApi'
import { CMSC, cmFmt, first, pc3, pctOf, type Agg, type CType, type Cell, type PayLine, type Row, type Tot, type Week } from './commitmentApi'

export const MBar = ({ p, c, pace }: { p: number | null | undefined; c?: string; pace?: number | null }) =>
  <span className="mbar8">{pace != null && <em style={{ left: `${pace}%` }} title="Where you should be by today" />}
    <i style={{ width: `${Math.max(0, Math.min(100, p || 0))}%`, ...(c ? { background: c } : {}) }} /></span>

export const Score = ({ s }: { s: number | null | undefined }) => s == null ? <span className="mu">—</span>
  : <span className="cm8-sc" style={{ ['--c' as string]: pc3(s) }}>{s}%</span>

export function WkBar({ week, onMove }: { week: Week; onMove: (d: -7 | 0 | 7) => void }) {
  const n = week.offset
  return <div className="cm8-wk">
    <button type="button" className="btn s" aria-label="Previous week" onClick={() => onMove(-7)}>‹</button>
    <div><b>{week.label}</b><small>{n === 0 ? `This week · day ${week.day} of 7` : n === -1 ? 'Next week' : n === 1 ? 'Last week' : `${n} weeks ago`}</small></div>
    <button type="button" className="btn s" aria-label="Next week" disabled={!week.can_next} onClick={() => onMove(7)}>›</button>
    {n !== 0 && <a onClick={() => onMove(0)}>This week</a>}
  </div>
}

/** prototype cmKpis: one card per enabled commitment type + the dashed "Commitments submitted" card. */
export function Kpis({ tot, types, rows, pace }: { tot: Tot; types: CType[]; rows: Row[]; pace: number | null }) {
  const self = rows.filter(r => !r.mgr), sub = self.filter(r => r.sub).length
  return <div className="cm8-kp">
    {types.map(t => { const x = tot[t.k]; if (!x) return null
      return <div key={t.k}><div className="row" style={{ gap: 6 }}><span className="cm8-ki"><Ic n={t.ic} /></span><small>{t.n}</small><span className="fl" />
        {x.p != null && <b className="cm8-pp" style={{ color: pc3(x.p) }}>{x.p}%</b>}</div>
        <b>{cmFmt(t, x.av)} <small>/ {cmFmt(t, x.cv)}</small></b>
        <MBar p={x.p} c={pc3(x.p)} pace={pace} />
        <small className="mu">{x.n} committed{t.money && x.pend ? ` · ${inr(x.pend)} awaiting finance` : !t.money && x.cvv ? ` · ${inr(x.avv)} of ${inr(x.cvv)}` : ''}</small></div> })}
    <div className="cm8-cmp"><small>Commitments submitted</small><b>{sub} <small>of {self.length}</small></b>
      <MBar p={pctOf(sub, self.length)} c={pc3(pctOf(sub, self.length))} />
      <small className="mu">{self.length - sub ? `${self.length - sub} not submitted` : 'Everyone has committed'}</small></div>
  </div>
}

export function CmCell({ t, x }: { t: CType; x: Cell | undefined }) {
  if (!x) return <span className="mu">—</span>
  if (x.cm) return <div className="cm8-c"><div className="cm8-cl"><b>{cmFmt(t, x.av)}</b><small> / {cmFmt(t, x.cv)}</small>
    <span className="cm8-p" style={{ color: pc3(x.p) }}>{x.p == null ? '' : `${x.p}%`}</span></div><MBar p={x.p} c={pc3(x.p)} /></div>
  if (x.av) return <div className="cm8-c"><b>{cmFmt(t, x.av)}</b><small className="mu"> · no commitment</small></div>
  return <span className="mu">not committed</span>
}

/** prototype cmMatrix: team rows with their members, then the manager (team) commitments – never added to the totals. */
export function Matrix({ rows, types, agg, onPick, first: head = 'Person' }: { rows: Row[]; types: CType[]; agg: Agg[]; onPick: (r: Row) => void; first?: string }) {
  const grp = [...new Set(rows.filter(r => !r.mgr).map(r => r.tk))], mg = rows.filter(r => r.mgr)
  const pr = (r: Row) => <tr key={`p${r.id}`} className="cm8-pr" tabIndex={0} onClick={() => onPick(r)} onKeyDown={e => { if (e.key === 'Enter') onPick(r) }}>
    <td><span className="row" style={{ gap: 6 }}><Av name={r.n} /><span><b>{r.n}</b><br /><small className="mu">{r.sub
      ? `${Object.values(r.ty).find(x => x?.cm)?.per || ''} commitment` : <span className="tbad">not submitted</span>}</small></span></span></td>
    {types.map(t => <td key={t.k}><CmCell t={t} x={r.ty[t.k]} /></td>)}<td className="r"><Score s={r.score} /></td></tr>
  if (!rows.length) return <div className="empty">No one in your team gives commitments – check Settings → Who gives commitments</div>
  return <div className="tw fit"><table className="t cm8-mx"><thead><tr><th>{head}</th>{types.map(t => <th key={t.k}><Ic n={t.ic} /> {t.n}</th>)}<th className="r">Score</th></tr></thead>
    <tbody>{grp.map(g => { const a = agg.find(x => x.tk === g)
      return [<tr key={`g${g}`} className="cm8-gr"><td><b>{g}</b> <small className="mu">{a?.sub ?? 0}/{a?.n ?? 0} committed</small></td>
        {types.map(t => <td key={t.k}>{a?.ty[t.k] ? <CmCell t={t} x={{ ...a.ty[t.k]!, cm: a.ty[t.k]!.cv > 0 }} /> : '—'}</td>)}<td className="r"><Score s={a?.score} /></td></tr>,
      ...rows.filter(r => !r.mgr && r.tk === g).sort((x, y) => (y.score ?? -1) - (x.score ?? -1)).map(pr)] })}
      {mg.length > 0 && <tr className="cm8-gr"><td colSpan={types.length + 2}><b>Manager commitments for the team</b> <small className="mu">compared with the whole team’s results – not added to the totals</small></td></tr>}
      {mg.map(pr)}</tbody></table></div>
}

/** prototype pbars(): label · bar · % */
export const PBars = ({ d }: { d: { l: string; v: number; c: string }[] }) => !d.length ? <div className="empty">Nothing to show</div>
  : <>{d.map(x => <div className="hbr" key={x.l}><span className="hbl" style={{ width: 150 }} title={x.l}>{x.l}</span>
    <span className="hbt"><i style={{ width: `${Math.min(100, Math.max(x.v ? 2 : 0, x.v))}%`, background: x.c }} /></span><b className="hbv" style={{ width: 44 }}>{x.v}%</b></div>)}</>

/** prototype heat(): rows × columns, cell shade = value 0–100 */
export function Heat({ rows, cols, v, t }: { rows: string[]; cols: string[]; v: (i: number, j: number) => number; t: (i: number, j: number) => string }) {
  if (!rows.length) return <div className="empty">No one has committed yet</div>
  return <div className="cm8-hm" style={{ gridTemplateColumns: `90px repeat(${cols.length}, minmax(14px, 1fr))` }}><span />
    {cols.map((c, j) => <small key={j} className="c">{c}</small>)}
    {rows.map((r, i) => <div key={i} style={{ display: 'contents' }}><small style={{ lineHeight: '13px' }} title={r}>{r}</small>
      {cols.map((_, j) => <i key={j} style={{ ['--v' as string]: v(i, j) }} title={t(i, j)} />)}</div>)}</div>
}

export function TenH({ l }: { l: { tender_id: number | null; tender: string | null; old_tender: string } }) {
  const nav = useNavigate()
  if (l.tender_id) return <a onClick={e => { e.stopPropagation(); nav(`/tenders/${l.tender_id}`) }}>{l.tender || `TND-${l.tender_id}`}</a>
  if (l.old_tender) return <>{l.old_tender} <span className="pill mu">old tender</span></>
  return <span className="mu">—</span>
}

/** Payment commitments table – By | Customer · tender | Committed | Received | Status */
export function PayTbl({ L, empty, showPer, onOpen }: { L: PayLine[]; empty: string; showPer?: boolean; onOpen?: (cid: number) => void }) {
  return <Tbl rows={L} empty={empty} onRow={onOpen ? x => onOpen(x.cid) : undefined} cols={[
    { k: 'o', t: 'By', fn: x => <span className="row" style={{ gap: 6 }}><Av name={x.owner} />{first(x.owner)}</span> },
    { k: 'cu', t: 'Customer · tender', fn: x => <>{x.customer.slice(0, 30)}<br /><small><TenH l={x} /></small></> },
    { k: 'v', t: 'Committed', r: true, fn: x => <>{inr(x.v)}{showPer && x.per !== 'Week' && <><br /><small className="mu">{x.per.toLowerCase()}</small></>}</> },
    { k: 'r', t: 'Received', r: true, fn: x => <>{inr(x.ack)}{x.pen > 0 && <><br /><small className="twarn">{inr(x.pen)} with Finance</small></>}</> },
    { k: 's', t: 'Status', fn: x => <Pill s={x.st} t={CMSC[x.st]} /> },
  ]} />
}

export function Loading({ err, retry }: { err?: string | null; retry?: () => void }) {
  return <div className="panel"><div className={err ? 'err-box' : 'empty'}>{err ? <>{err} {retry && <button type="button" className="btn s" onClick={retry}>Retry</button>}</> : 'Loading…'}</div></div>
}
