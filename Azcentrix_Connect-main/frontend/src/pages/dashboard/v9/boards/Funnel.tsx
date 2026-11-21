import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '@/services/api'
import { useToast } from '@/components/ui/ToastContext'
import { Avatar, Bar, Btn, Empty, Pill, Strip, inr } from '@/components/platform/bw'
import { Ic } from '@/components/crm/kit'
import { usePermissions } from '@/hooks'
import { PERM, pct, useBoard, type Period } from '../data'
import { ErrorBox, LoadingBox, NoAccess } from '../ui'
import './funnel.css'

// Dashboards › Funnel – prototype v17 funnelBoard(true) (p32 board, p34 records analytics + compare). Rows come from
// GET /dashboard/v9/funnel (each module's own permissions + the dashboard's data visibility); everything below is computed
// from them in the browser like the prototype. Unknown values (stage age without a recorded stage date, probability that the
// CRM does not hold) are shown as "—", never estimated.

export type K = 'leads' | 'opps' | 'tenders' | 'quotes'
export type Row = { k: K; id: number; ref: string; name: string; segment: string; sub: string; customer: string; vertical: string; biz: string; owner: string; owner_id: number | null
  company: string; stage: string; kind: 'open' | 'won' | 'lost'; value: number; date: string | null; closed: string | null; age: number | null; sla: number | null
  flow: string; flow_name: string; stuck: boolean; customer_id?: number | null; j?: string; reason?: string | null; prob?: number | null; due?: string | null; converted?: boolean }
export type Ord = { id: number; ref: string; value: number; flow_name: string; segment: string; sub: string; customer: string; vertical: string; biz: string; owner: string; company: string; stage: string }
export type Flow = { key: string; name: string; stages: { name: string; kind: string; sla: number }[] }
export type Board = { rows: Row[]; orders: Ord[]; flows: Partial<Record<K, Flow[]>>; company: string; today: string }
type Step = { l: string; n: number; v: number; here: Row[]; stuck: Row[]; i: number; cv: number; sla: number | null }

const FOBJ = ['Whole journey', 'Leads', 'Deals', 'Bids & Tenders', 'Quotes'] as const
type Obj = typeof FOBJ[number]
const OBJK: Record<Obj, K | null> = { 'Whole journey': null, Leads: 'leads', Deals: 'opps', 'Bids & Tenders': 'tenders', Quotes: 'quotes' }
// prototype FDIM after p27 (Flow) and p33 (customer / record wording)
export const FDIM: [string, string][] = [['Stage', 'stage'], ['Flow', 'flow_name'], ['Customer segment', 'segment'], ['Customer sub-segment', 'sub'], ['Business vertical (deal)', 'vertical'], ['Business model', 'biz'], ['Main customer', 'customer'], ['Owner', 'owner'], ['Company', 'company']]
const FPER: Record<string, number> = { All: 9999, 'Last 30 days': 30, 'Last quarter': 90, 'Last 6 months': 180 }
const AGEB: [string, number, number][] = [['0–7 d', 0, 7], ['8–21 d', 8, 21], ['22–45 d', 22, 45], ['45+ d', 46, 9999]]
export const TL: Record<K, string> = { leads: 'Lead', opps: 'Deal', tenders: 'Tender', quotes: 'Quote' }
export const LINK: Record<K, (id: number) => string> = { leads: id => `/leads/${id}`, opps: id => `/opportunities/${id}`, tenders: id => `/tenders/${id}`, quotes: id => `/quotations/${id}` }
export const dimLbl = (d: string) => (FDIM.find(x => x[1] === d) || [d])[0]
export const dimVal = (r: Row | Ord, d: string): string => String((r as any)[d] ?? '—') || '—'
export const sum = <T,>(a: T[], f: (x: T) => number) => a.reduce((s, x) => s + (f(x) || 0), 0)
export const won = (r: Row) => r.kind === 'won', lost = (r: Row) => r.kind === 'lost', open = (r: Row) => r.kind === 'open'
export const daysAgo = (d: string | null, today: string) => d ? Math.round((Date.parse(today) - Date.parse(d)) / 864e5) : null
// probability the CRM records: lead score, the deal's stage probability, or 100 / 0 once decided – otherwise unknown
const probOf = (r: Row): number | null => won(r) ? 100 : lost(r) ? 0 : r.prob ?? null
const riskOf = (r: Row, today: string): [string, string] => won(r) ? ['Won', 'ok'] : lost(r) ? ['Lost', 'mu'] : r.stuck ? ['Stuck', 'ba']
  : r.due && Date.parse(r.due) < Date.parse(today) ? ['Overdue', 'wa'] : ['On track', 'ok']

// prototype funnelSteps('Whole journey'): leads → qualified / converted → deals → bids & quotes → won → orders
export function journeySteps(R: Row[], orders: Ord[]): { l: string; n: number; v: number }[] {
  const L = R.filter(x => x.k === 'leads'), O = R.filter(x => x.k === 'opps'), B = R.filter(x => x.k === 'tenders' || x.k === 'quotes')
  const Q = L.filter(x => x.converted || x.stage === 'Qualified' || won(x)), W = R.filter(x => x.k !== 'leads' && won(x))
  return [{ l: 'Leads', n: L.length, v: sum(L, x => x.value) }, { l: 'Qualified / converted', n: Q.length, v: sum(Q, x => x.value) },
    { l: 'Deals', n: O.length, v: sum(O, x => x.value) }, { l: 'Bids & quotes', n: B.length, v: sum(B, x => x.value) },
    { l: 'Won', n: W.length, v: sum(W, x => x.value) }, { l: 'Orders', n: orders.length, v: sum(orders, o => o.value) }]
}

export function stats(rows: Row[]) {
  const w = rows.filter(won), l = rows.filter(lost), o = rows.filter(open)
  return { n: rows.length, w: w.length, l: l.length, o: o.length, val: sum(rows, r => r.value), wv: sum(w, r => r.value), ov: sum(o, r => r.value), cv: pct(w.length, w.length + l.length) }
}

export default function Funnel({ period, nonce }: { period: Period; nonce: number }) {
  const { can } = usePermissions()
  const r = useBoard<Board>('funnel', period, can(PERM.base), nonce)
  if (r.denied) return <NoAccess what="the funnel" />
  if (r.loading) return <LoadingBox />
  if (r.error || !r.data) return <ErrorBox msg={r.error || 'Could not load the funnel'} />
  return <FunnelBoard d={r.data} />
}

export function FunnelBoard({ d, initDrill = [] }: { d: Board; initDrill?: [string, string][] }) {
  const navigate = useNavigate()
  const { success, error: showError } = useToast()
  const [obj, setObj] = useState<Obj>('Whole journey')
  const [flow, setFlow] = useState('')
  const [per, setPer] = useState('All')
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [drill, setDrill] = useState<[string, string][]>(initDrill)
  const [stage, setStage] = useState<string | null>(null)
  const [fl, setFl] = useState<string[]>(['segment', 'vertical', 'customer'])
  const [fx, setFx] = useState<Record<string, boolean>>({})
  const [bm, setBm] = useState(60)
  const [wi, setWi] = useState({ i: 1, p: 10 })
  const [cmp, setCmp] = useState<[string | null, string | null]>([null, null])
  const [ftype, setFtype] = useState<K | ''>('')
  const [fage, setFage] = useState('')
  const [fsort, setFsort] = useState('value')
  const [nudged, setNudged] = useState<Set<string>>(new Set())
  const today = d.today
  const ok = OBJK[obj]
  const FLs = ok ? d.flows[ok] || [] : []

  // prototype fRows / fData: object, drill-down, open only, flow, period
  const base = useMemo(() => d.rows.filter(x => (!ok || x.k === ok) && drill.every(([k, v]) => dimVal(x, k) === v) && (!onlyOpen || open(x))
    && (!flow || !ok || x.flow === flow)), [d.rows, ok, drill, onlyOpen, flow])
  const rows = useMemo(() => {
    const lim = FPER[per] ?? 9999
    return lim < 9999 ? base.filter(x => { const a = daysAgo(x.date, today); return a == null || a <= lim }) : base
  }, [base, per, today])

  // prototype funnelSteps
  const steps = (R: Row[]): Omit<Step, 'here' | 'stuck' | 'i' | 'cv' | 'sla'>[] => {
    if (!ok) return journeySteps(R, d.orders.filter(o => drill.every(([k, v]) => k === 'stage' || dimVal(o, k) === v)))
    const fls = flow ? FLs.filter(f => f.key === flow) : FLs
    const names: string[] = []
    fls.forEach(f => f.stages.forEach(s => { if (s.kind === 'open' && !names.includes(s.name)) names.push(s.name) }))
    const st = names.map((n, i) => {
      const at = R.filter(x => x.stage === n), past = R.filter(x => { const j = names.indexOf(x.stage); return j > i || won(x) })
      return { l: n, n: at.length + past.length, v: sum([...at, ...past], x => x.value) }
    })
    const w = R.filter(won)
    st.push({ l: 'Won', n: w.length, v: sum(w, x => x.value) })
    return st
  }
  const slaOf = (n: string) => { for (const f of FLs) { const s = f.stages.find(x => x.name === n); if (s?.sla) return s.sla } return null }
  const st: Step[] = useMemo(() => {
    const s0 = steps(rows)
    return s0.map((s, i) => {
      const here = rows.filter(x => x.stage === s.l && open(x))
      return { ...s, i, cv: i && s0[i - 1].n ? Math.min(100, Math.round(s.n / s0[i - 1].n * 100)) : 100, here, stuck: here.filter(x => x.stuck), sla: slaOf(s.l) }
    })
  }, [rows, obj, flow]) // eslint-disable-line react-hooks/exhaustive-deps
  const s = stats(rows)
  const last = st[st.length - 1] || { n: 0, v: 0 }
  const bigLeak = st.slice(1).reduce<Step | null>((m, x) => (!m || x.cv < m.cv ? x : m), null)
  const stuckR = rows.filter(x => x.stuck)
  const stuckV = sum(stuckR, x => x.value)
  const recs = rows.filter(x => !stage || x.stage === stage)

  const focus = (dim: string, v: string) => {
    const nd: [string, string][] = [...drill.filter(([k]) => k !== dim), [dim, v]]
    const used = nd.map(x => x[0]), nx = fl.filter(x => x && !used.includes(x)), pool = ['segment', 'vertical', 'customer', 'sub', 'owner', 'biz'].filter(x => !used.includes(x) && !nx.includes(x))
    setDrill(nd); setFl([...nx, ...pool].slice(0, 3)); setFx({}); success(`Focused on ${v}`)
  }
  const nudge = async (x: Row) => {
    try {
      const { data } = await api.post<{ sent: boolean; to: string }>('/dashboard/v9/funnel/nudge', { k: x.k, id: x.id })
      setNudged(n => new Set(n).add(`${x.k}:${x.id}`))
      success(`Reminder sent to ${data.to || x.owner}`)
    } catch (e: any) { showError(e?.response?.data?.detail || 'Could not send the reminder') }
  }
  const exportCsv = () => {
    const cols: [string, (r: Row) => any][] = [['Type', r => TL[r.k]], ['ID', r => r.ref || r.id], ['Name', r => r.name], ['Customer', r => r.customer], ['Segment', r => r.segment],
      ['Sub-segment', r => r.sub], ['Vertical', r => r.vertical], ['Business model', r => r.biz], ['Stage', r => r.stage], ['Value', r => r.value], ['Owner', r => r.owner],
      ['Days in stage', r => r.age ?? ''], ['SLA (days)', r => r.sla ?? ''], ['Status', r => riskOf(r, today)[0]]]
    const esc = (v: any) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
    const csv = [cols.map(c => c[0]).join(','), ...recs.map(r => cols.map(c => esc(c[1](r))).join(','))].join('\n')
    const a = document.createElement('a')
    a.href = window.URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `Funnel_${obj.replace(/\W+/g, '_')}_${today}.csv`; a.click(); setTimeout(() => window.URL.revokeObjectURL(a.href), 1000)
  }
  const go = (x: Row) => navigate(LINK[x.k](x.id))

  return <div className="fnm">
    <div className="fctl">
      <div className="seg">{FOBJ.map(o => <button key={o} type="button" className={o === obj ? 'on' : ''} onClick={() => { setObj(o); setFlow(''); setStage(null) }}>{o}</button>)}</div>
      {FLs.length > 0 && <select className="bwd-per fsel" value={flow} onChange={e => { setFlow(e.target.value); setStage(null) }} aria-label="Flow">
        <option value="">All flows</option>{FLs.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}</select>}
      <select className="bwd-per fsel" value={per} onChange={e => setPer(e.target.value)} aria-label="Period">{Object.keys(FPER).map(p => <option key={p}>{p}</option>)}</select>
      <label className="fopen"><input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} /> Open only</label>
    </div>
    <div className="fcr"><span className="mu"><Ic n="filter" size={14} /> Drill-down</span>
      <button type="button" className={`bw-chip ${drill.length ? '' : 'on'}`} onClick={() => { setDrill([]); setStage(null) }}>Everything</button>
      {drill.map(([k, v], i) => <span key={k} className="fcr-i"><span className="mu">›</span><button type="button" className="bw-chip on" onClick={() => setDrill(drill.slice(0, i))}>{dimLbl(k)}: {v} ✕</button></span>)}
      {stage && <span className="fcr-i"><span className="mu">›</span><button type="button" className="bw-chip on" onClick={() => setStage(null)}>Stage: {stage} ✕</button></span>}
    </div>

    <Strip items={[
      { l: 'In funnel', v: s.n.toLocaleString('en-IN') }, { l: 'Funnel value', v: inr(s.val) }, { l: 'Open value', v: inr(s.ov) }, { l: 'Reached last step', v: last.n.toLocaleString('en-IN') },
      { l: 'End-to-end conversion', v: `${pct(last.n, st[0]?.n || 1)}%`, dc: 'tok' }, { l: 'Win rate (closed)', v: s.w + s.l ? `${s.cv}%` : '—' },
      { l: 'Biggest leak', v: bigLeak ? bigLeak.l : '—', dc: 'twarn' }, { l: 'Stuck value', v: inr(stuckV), dc: stuckV ? 'tbad' : undefined },
    ]} />

    <div className="bw-g g21 mb">
      <Panel icon="funnel" t={`${obj} funnel${flow ? ' · ' + (FLs.find(f => f.key === flow)?.name || '') : ''}`} act={<small className="mu">click a stage to see its records</small>} z>
        {st[0]?.n ? <BigFunnel st={st} sel={stage} onPick={l => setStage(stage === l ? null : l)} /> : <Empty>No records in this view</Empty>}
      </Panel>
      <div className="fside">
        <Panel icon="chart" t="Movement · last 30 days"><Movement rows={rows} today={today} /></Panel>
        <Panel icon="target" t="Stage health vs benchmark">
          <div className="bn">{st.slice(1).map(x => { const c = x.cv < bm - 20 ? 'bad' : x.cv < bm ? 'mid' : 'ok'; return <div key={x.l} className="bn-r"><span className="bn-l" title={x.l}>{x.l}</span><div className="bn-b"><i style={{ width: `${x.cv}%` }} className={c} /><em style={{ left: `${bm}%` }} /></div><b className={c === 'bad' ? 'tbad' : c === 'mid' ? 'twarn' : 'tok'}>{x.cv}%</b></div> })}</div>
          <div className="bn-bm"><span className="mu">Benchmark</span><input type="range" min={30} max={90} value={bm} onChange={e => setBm(+e.target.value)} aria-label="Benchmark conversion" /><b>{bm}%</b></div>
        </Panel>
      </div>
    </div>

    <div className="bw-panel mb">
      <div className="ph"><Ic n="layout" size={15} /> Drill-down · {fl.filter(Boolean).map(dimLbl).join(' › ')}<span className="flex-1" /><small className="mu">expand rows to go deeper · Focus filters the whole page</small></div>
      <div className="pb"><div className="dt-path"><span className="mu">Drill path</span>
        {[0, 1, 2].map(i => <span key={i} className="fcr-i">{i > 0 && <span className="mu">›</span>}
          <select className="bwd-per fsel" value={fl[i] || ''} onChange={e => { const v = e.target.value; let n = [...fl]; n[i] = v; if (!v) n = n.slice(0, i); n = n.filter((x, j, a) => x && a.indexOf(x) === j); setFl(n); setFx({}) }} aria-label={`Drill level ${i + 1}`}>
            {i > 0 && <option value="">—</option>}{FDIM.filter(x => x[1] !== 'stage').map(([l, k]) => <option key={k} value={k}>{l}</option>)}</select></span>)}
        <span className="flex-1" /><Btn s g onClick={() => { const n: Record<string, boolean> = {}; const walk = (R: Row[], lv: number, p: string) => { const dd = fl[lv]; if (!dd || !fl[lv + 1]) return; const g: Record<string, Row[]> = {}; R.forEach(x => { (g[dimVal(x, dd)] ??= []).push(x) }); Object.entries(g).forEach(([v, L]) => { n[p + '¦' + v] = true; walk(L, lv + 1, p + '¦' + v) }) }; walk(rows, 0, ''); setFx(n) }}>Expand all</Btn>
        <Btn s g onClick={() => setFx({})}>Collapse</Btn></div></div>
      <div className="pb z"><div className="dtw"><table className="w-full text-left dt">
        <thead><tr><th>{fl.filter(Boolean).map(dimLbl).join(' › ')}</th><th className="text-right">Records</th><th>Funnel shape</th><th className="text-right">Open</th><th className="text-right">Won</th><th className="text-right">Lost</th><th>Win rate</th><th className="text-right">Open value</th><th className="text-right">Won value</th><th /></tr></thead>
        <tbody>{rows.length ? <Tree rows={rows} lv={0} path="" depth={0} fl={fl} fx={fx} setFx={setFx} steps={steps} onFocus={focus} /> : <tr><td colSpan={10}><Empty>No records in this view</Empty></td></tr>}</tbody>
      </table></div></div>
    </div>

    <div className="bw-g g3 mb">
      <Panel icon="alert" t="Stuck beyond SLA · act now" act={<small className="mu">{stuckR.length} records</small>} z>
        {stuckR.length ? <div className="bw-list fscroll">{stuckR.slice().sort((a, b) => b.value - a.value).slice(0, 8).map(x => <div key={`${x.k}:${x.id}`}>
          <span className="min-w-0 flex-1"><a className="flink" onClick={() => go(x)}><b>{(x.name || x.ref).slice(0, 40)}</b></a><br /><small className="mu">{x.stage} · {x.age} d (SLA {x.sla} d) · {x.owner}</small></span>
          <b className="tabular-nums">{inr(x.value)}</b>
          <Btn s disabled={!x.owner_id || nudged.has(`${x.k}:${x.id}`)} onClick={() => nudge(x)} title={x.owner_id ? `Send ${x.owner} a reminder` : 'No owner to remind'}>{nudged.has(`${x.k}:${x.id}`) ? 'Nudged' : 'Nudge'}</Btn>
        </div>)}</div> : <Empty>Nothing is stuck beyond its SLA</Empty>}
      </Panel>
      <Panel icon="spark" t="What-if · lift a stage"><WhatIf st={st} wi={wi} setWi={setWi} /></Panel>
      <Panel icon="scale" t={`Compare ${dimLbl(fl[0] || 'segment')}s`}><Compare rows={rows} d={fl[0] || 'segment'} cmp={cmp} setCmp={setCmp} steps={steps} /></Panel>
    </div>

    <Panel icon="table" t={`Records ${stage ? `at “${stage}”` : 'in this view'} · ${recs.length}`} act={<Btn s onClick={exportCsv} disabled={!recs.length}><Ic n="dl" size={13} /> Export</Btn>} z>
      <RecTable recs={recs} flows={d.flows} today={today} ftype={ftype} setFtype={setFtype} fage={fage} setFage={setFage} fsort={fsort} setFsort={setFsort} onOpen={go} />
    </Panel>
  </div>
}

function Panel({ icon, t, act, z, children }: { icon: string; t: string; act?: ReactNode; z?: boolean; children: ReactNode }) {
  return <div className="bw-panel"><div className="ph"><Ic n={icon} size={15} /> {t}{act && <><span className="flex-1" />{act}</>}</div><div className={`pb ${z ? 'z' : ''}`}>{children}</div></div>
}

// prototype bigFunnel(): trapezoid per step, width never grows down the funnel
function BigFunnel({ st, sel, onPick }: { st: Step[]; sel: string | null; onPick: (l: string) => void }) {
  const mx = Math.max(...st.map(s => s.n), 1), H = 46, W: number[] = []
  st.forEach((s, i) => { W[i] = Math.max(14, Math.min(i ? W[i - 1] : 100, s.n / mx * 100)) })
  return <div className="bf">
    <svg width="0" height="0" style={{ position: 'absolute' }}><defs>
      <linearGradient id="bfg0" x1="0" x2="1"><stop offset="0" stopColor="color-mix(in srgb, var(--bw-ac) 75%, #fff)" /><stop offset="1" stopColor="var(--bw-ac)" /></linearGradient>
      <linearGradient id="bfg1" x1="0" x2="1"><stop offset="0" stopColor="color-mix(in srgb, var(--bw-ac) 60%, #fff)" /><stop offset="1" stopColor="color-mix(in srgb, var(--bw-ac) 88%, #000)" /></linearGradient>
    </defs></svg>
    {st.map((s, i) => { const w = W[i], nx = i < st.length - 1 ? W[i + 1] : Math.max(12, w * .8)
      return <div key={s.l} className={`bf-r ${sel === s.l ? 'on' : ''}`} role="button" tabIndex={0} onClick={() => onPick(s.l)} onKeyDown={e => { if (e.key === 'Enter') onPick(s.l) }}>
        <div className="bf-l"><b>{s.l}</b><small>{s.here.length ? `${s.here.length} sitting here` : ' '}{s.stuck.length > 0 && <> · <span className="tbad">{s.stuck.length} stuck</span></>}</small></div>
        <div className="bf-v"><svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none"><polygon points={`${50 - w / 2},0 ${50 + w / 2},0 ${50 + nx / 2},${H} ${50 - nx / 2},${H}`} fill={`url(#bfg${i % 2})`} /></svg><span><b>{s.n}</b></span></div>
        <div className="bf-c"><b className="bf-val">{inr(s.v)}</b>{i ? <><span className={`cvp ${s.cv < 40 ? 'bad' : s.cv < 65 ? 'mid' : 'ok'}`}>{s.cv}%</span><small>conversion</small></> : <small className="mu">entry</small>}</div>
      </div> })}
  </div>
}

// prototype movement(), from recorded dates: created in 30 d, moved into the current stage in 30 d, won / lost in 30 d, open > 21 d in stage
function Movement({ rows, today }: { rows: Row[]; today: string }) {
  const in30 = (v: string | null) => { const a = daysAgo(v, today); return a != null && a >= 0 && a <= 30 }
  const m: [string, number, string][] = [['Entered', rows.filter(x => in30(x.date)).length, 'in'],
    ['Advanced', rows.filter(x => open(x) && x.age != null && x.age <= 30 && !in30(x.date)).length, 'ac'],
    ['Won', rows.filter(x => won(x) && in30(x.closed)).length, 'ok'], ['Lost', rows.filter(x => lost(x) && in30(x.closed)).length, 'ba'],
    ['Stalled > 21 d', rows.filter(x => open(x) && (x.age ?? 0) > 21).length, 'wa']]
  return <div className="mv">{m.map(([l, n, c]) => <div key={l} className={`mv-${c}`}><b>{n}</b><small>{l}</small></div>)}</div>
}

function Tree({ rows, lv, path, depth, fl, fx, setFx, steps, onFocus }: { rows: Row[]; lv: number; path: string; depth: number; fl: string[]; fx: Record<string, boolean>; setFx: (f: Record<string, boolean>) => void
  steps: (R: Row[]) => { l: string; n: number }[]; onFocus: (d: string, v: string) => void }) {
  const dd = fl[lv]
  if (!dd) return null
  const g: Record<string, Row[]> = {}
  rows.forEach(x => { (g[dimVal(x, dd)] ??= []).push(x) })
  return <>{Object.entries(g).sort((a, b) => sum(b[1], x => x.value) - sum(a[1], x => x.value)).map(([v, R]) => {
    const key = path + '¦' + v, isOpen = fx[key], s = stats(R), has = !!fl[lv + 1], ms = steps(R), mx = Math.max(ms[0]?.n || 0, 1)
    return <FragmentRow key={key}>
      <tr className={`dt-r d${depth}`}>
        <td><span className="dt-n" style={{ paddingLeft: depth * 20 }}>{has ? <button type="button" className="dt-t" onClick={() => setFx({ ...fx, [key]: !isOpen })} aria-label={isOpen ? 'Collapse' : 'Expand'}>{isOpen ? '▾' : '▸'}</button> : <span className="dt-t0" />}
          <span className="dt-lv">{dimLbl(dd)}</span><b title={v}>{v.length > 34 ? v.slice(0, 32) + '…' : v}</b></span></td>
        <td className="text-right tabular-nums">{s.n}</td>
        <td><span className="mf">{ms.map((x, i) => <i key={x.l} title={`${x.l}: ${x.n}`} style={{ height: Math.max(3, x.n / mx * 22), opacity: 1 - i * .06 }} />)}</span></td>
        <td className="text-right tabular-nums">{s.o}</td><td className="text-right tabular-nums tok">{s.w}</td><td className="text-right tabular-nums tbad">{s.l}</td>
        <td style={{ minWidth: 110 }}>{s.w + s.l ? <Bar value={s.cv} /> : <span className="mu">—</span>}</td>
        <td className="text-right tabular-nums">{inr(s.ov)}</td><td className="text-right tabular-nums"><b>{inr(s.wv)}</b></td>
        <td className="text-right"><Btn s g onClick={() => onFocus(dd, v)} title="Filter the whole page to this">Focus</Btn></td>
      </tr>
      {isOpen && <Tree rows={R} lv={lv + 1} path={key} depth={depth + 1} fl={fl} fx={fx} setFx={setFx} steps={steps} onFocus={onFocus} />}
    </FragmentRow>
  })}</>
}
const FragmentRow = ({ children }: { children: ReactNode }) => <>{children}</>

function WhatIf({ st, wi, setWi }: { st: Step[]; wi: { i: number; p: number }; setWi: (w: { i: number; p: number }) => void }) {
  if (st.length < 2) return <Empty>Needs at least two steps</Empty>
  const i = Math.min(Math.max(1, wi.i), st.length - 1), p = wi.p, s = st[i], last = st[st.length - 1]
  const f = s.cv ? Math.min(100, s.cv + p) / s.cv : 1, addN = Math.round(last.n * (f - 1)), avgW = last.n ? last.v / last.n : 0
  return <>
    <div className="wi-f"><label>Improve conversion at</label><select className="bwd-per fsel w-full" value={i} onChange={e => setWi({ ...wi, i: +e.target.value })}>
      {st.slice(1).map(x => <option key={x.i} value={x.i}>{x.l} (now {x.cv}%)</option>)}</select></div>
    <div className="wi-f"><label>By (percentage points): <b>+{p}</b></label><input type="range" min={1} max={30} value={p} onChange={e => setWi({ ...wi, p: +e.target.value })} className="w-full" aria-label="Percentage points" /></div>
    <div className="wi"><div><label>Extra closures</label><b className="tok">+{addN}</b></div><div><label>Extra won value</label><b className="tok">{inr(addN * avgW)}</b></div><div><label>New stage conversion</label><b>{Math.min(100, s.cv + p)}%</b></div></div>
  </>
}

// prototype p34 compare(): two values of the first drill level, six metrics head-to-head, then stage by stage
function Compare({ rows, d, cmp, setCmp, steps }: { rows: Row[]; d: string; cmp: [string | null, string | null]; setCmp: (c: [string | null, string | null]) => void; steps: (R: Row[]) => { l: string; n: number }[] }) {
  const vals = [...new Set(rows.map(x => dimVal(x, d)))].sort()
  if (!vals.length) return <Empty>No records to compare</Empty>
  const a = cmp[0] && vals.includes(cmp[0]) ? cmp[0] : vals[0], b = cmp[1] && vals.includes(cmp[1]) ? cmp[1] : (vals[1] || vals[0])
  const RA = rows.filter(x => dimVal(x, d) === a), RB = rows.filter(x => dimVal(x, d) === b), sa = stats(RA), sb = stats(RB), A_ = steps(RA), B_ = steps(RB)
  const avg = (x: ReturnType<typeof stats>) => (x.w ? x.wv / x.w : 0)
  const M: [string, number, number, (v: number) => string][] = [['Records', sa.n, sb.n, v => String(v)], ['Open value', sa.ov, sb.ov, inr], ['Won value', sa.wv, sb.wv, inr],
    ['Win rate', sa.cv, sb.cv, v => `${v}%`], ['Avg won deal', avg(sa), avg(sb), inr], ['Open records', sa.o, sb.o, v => String(v)]]
  const mx = Math.max(A_[0]?.n || 0, B_[0]?.n || 0, 1)
  const sel = (i: 0 | 1, v: string) => <select className="bwd-per fsel" value={v} onChange={e => { const n: [string | null, string | null] = [...cmp] as any; n[i] = e.target.value; setCmp(n) }} aria-label={`Compare ${i ? 'second' : 'first'}`}>{vals.map(x => <option key={x}>{x}</option>)}</select>
  return <div className="c2">
    <div className="c2-h"><div className="c2-a"><span className="c2-dot a" />{sel(0, a)}</div><span className="c2-vs">VS</span><div className="c2-a"><span className="c2-dot b" />{sel(1, b)}</div></div>
    <div className="c2-m">{M.map(([l, x, y, f]) => { const w = x === y ? 0 : x > y ? 1 : 2, m = Math.max(x, y, 1)
      return <div key={l} className="c2-row"><div className={`c2-v ${w === 1 ? 'win' : ''}`}><span>{f(x)}</span><i style={{ width: `${x / m * 100}%` }} /></div><label>{l}</label><div className={`c2-v r ${w === 2 ? 'win' : ''}`}><i style={{ width: `${y / m * 100}%` }} /><span>{f(y)}</span></div></div> })}</div>
    <div className="c2-s"><label>Stage by stage</label>{A_.map((s, i) => { const t = B_[i] || { n: 0 }
      return <div key={s.l} className="c2-st"><span title={s.l}>{s.l}</span><div><i className="a" style={{ width: `${s.n / mx * 100}%` }} /><i className="b" style={{ width: `${t.n / mx * 100}%` }} /></div><b>{s.n} · {t.n}</b></div> })}</div>
  </div>
}

// prototype p34 recTable(): by type · open records by age · risk · sort, then the records
function RecTable({ recs, flows, today, ftype, setFtype, fage, setFage, fsort, setFsort, onOpen }: { recs: Row[]; flows: Board['flows']; today: string; ftype: K | ''; setFtype: (k: K | '') => void
  fage: string; setFage: (a: string) => void; fsort: string; setFsort: (s: string) => void; onOpen: (r: Row) => void }) {
  let R = recs.filter(x => (!ftype || x.k === ftype) && (!fage || (() => { const b = AGEB.find(a => a[0] === fage)!; return x.age != null && x.age >= b[1] && x.age <= b[2] })()))
  const wv = (x: Row) => { const p = probOf(x); return p == null ? -1 : x.value * p / 100 }
  R = R.slice().sort(fsort === 'age' ? (a, b) => (b.age ?? -1) - (a.age ?? -1) : fsort === 'risk' ? (a, b) => (riskOf(a, today)[0] === 'Stuck' ? 0 : 1) - (riskOf(b, today)[0] === 'Stuck' ? 0 : 1) || b.value - a.value
    : fsort === 'weighted' ? (a, b) => wv(b) - wv(a) : (a, b) => b.value - a.value)
  const byT = (Object.keys(TL) as K[]).map(k => ({ k, n: recs.filter(x => x.k === k).length, v: sum(recs.filter(x => x.k === k), x => x.value) })).filter(x => x.n)
  const ageC = AGEB.map(([l, a, b]) => ({ l, n: recs.filter(x => open(x) && x.age != null && x.age >= a && x.age <= b).length })), mxA = Math.max(...ageC.map(x => x.n), 1)
  const rk: Record<string, number> = {}
  recs.forEach(x => { const r = riskOf(x, today)[0]; rk[r] = (rk[r] || 0) + 1 })
  const stepOf = (x: Row) => { const f = (flows[x.k] || []).find(f => f.key === x.flow); const ST = f ? f.stages.filter(s => s.kind === 'open') : []; const i = ST.findIndex(s => s.name === x.stage); return i >= 0 ? `step ${i + 1} of ${ST.length}` : '' }
  return <>
    <div className="ra">
      <div className="ra-c"><label>By type</label><div className="ra-chips"><button type="button" className={`bw-chip ${!ftype ? 'on' : ''}`} onClick={() => setFtype('')}>All {recs.length}</button>
        {byT.map(t => <button key={t.k} type="button" className={`bw-chip ${ftype === t.k ? 'on' : ''}`} onClick={() => setFtype(t.k)}>{TL[t.k]} {t.n} · {inr(t.v)}</button>)}</div></div>
      <div className="ra-c"><label>Open records by age</label><div className="ra-age">{ageC.map(a => <div key={a.l} className={fage === a.l ? 'on' : ''} role="button" tabIndex={0} onClick={() => setFage(fage === a.l ? '' : a.l)}>
        <i style={{ height: Math.max(4, a.n / mxA * 36) }} /><b>{a.n}</b><small>{a.l}</small></div>)}</div></div>
      <div className="ra-c"><label>Risk</label><div className="ra-chips">{Object.entries(rk).map(([l, n]) => <span key={l} className={`sg ${({ Stuck: 'ba', Overdue: 'wa', 'On track': 'ok', Won: 'ok', Lost: '' } as any)[l] || ''}`}>{l} <b>{n}</b></span>)}</div></div>
      <div className="ra-c"><label>Sort by</label><select className="bwd-per fsel" value={fsort} onChange={e => setFsort(e.target.value)} aria-label="Sort records">
        {[['value', 'Value'], ['weighted', 'Weighted value'], ['age', 'Age (oldest first)'], ['risk', 'Risk (stuck first)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
    </div>
    <div className="ftbl"><table className="w-full text-left">
      <thead><tr><th>Record</th><th>Customer · segment</th><th>Vertical</th><th>Stage</th><th>Days in stage vs SLA</th><th className="text-right">Prob.</th><th className="text-right">Value</th><th className="text-right">Weighted</th><th>Owner</th><th>Status</th></tr></thead>
      <tbody>{R.slice(0, 80).map(x => { const p = probOf(x), rs = riskOf(x, today), sl = x.sla, a = x.age, so = stepOf(x)
        return <tr key={`${x.k}:${x.id}`}>
          <td><span className="fpill"><Pill t="mu">{TL[x.k]}</Pill></span><a className="flink" onClick={() => onOpen(x)}><b>{(x.name || x.ref).slice(0, 36)}</b></a><br /><small className="mu">{x.ref}</small></td>
          <td>{x.customer.slice(0, 28)}<br /><small className="mu">{x.segment}</small></td>
          <td><small>{x.vertical}</small></td>
          <td><Pill t={won(x) ? 'ok' : lost(x) ? 'ba' : 'inf'}>{x.stage}</Pill>{so && <><br /><small className="mu">{so}</small></>}</td>
          <td>{!open(x) ? <small className="mu">closed</small> : a != null && sl ? <><div className="sla"><i style={{ width: `${Math.min(100, a / sl / 2 * 100)}%` }} className={a > sl ? 'bad' : a > sl * .7 ? 'mid' : 'ok'} /><em style={{ left: '50%' }} /></div><small className={a > sl ? 'tbad' : 'mu'}>{a} d · SLA {sl} d</small></>
            : <small className="mu">{a != null ? `${a} d · no SLA` : '—'}</small>}</td>
          <td className="text-right tabular-nums">{p == null ? '—' : `${p}%`}</td>
          <td className="text-right tabular-nums"><b>{inr(x.value)}</b></td>
          <td className="text-right tabular-nums">{p == null ? '—' : inr(x.value * p / 100)}</td>
          <td><span className="fown"><Avatar name={x.owner} size={20} /> {x.owner.split(' ')[0]}</span></td>
          <td><span className={`sg ${rs[1]}`}>{rs[0]}</span></td>
        </tr> })}
        {!R.length && <tr><td colSpan={10}><Empty>No records</Empty></td></tr>}</tbody>
    </table></div>
    {R.length > 80 && <div className="mu fmore">Showing 80 of {R.length} – narrow with the filters above</div>}
  </>
}
