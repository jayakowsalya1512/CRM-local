// Field Sales 360 → Commitments (prototype v18 cmTab): Overview · Commitments · Weekly report · Settings.
// Overview = week bar + team chips, cmKpis, the team × person matrix, payment commitments this week and who has not
// submitted; clicking a person opens their view (cmPerson). Every number comes from /api/v1/commitments – the same
// records and calculations as Dashboard → Commitments.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { Switch } from '@/components/platform/bw'
import { useToast } from '@/components/ui/ToastContext'
import { Av, Bars, Line, PALC as PAL, Panel, Pill, Tbl } from '@/pages/customers/kit'
import { fd, inr } from '@/pages/customers/customerApi'
import { addD, cmApi, cmFmt, errText, first, fmtN, lakh, pc3, pctOf, stTone, type Agg, type CSummary, type CType, type Cell, type Detail, type Meta, type PersonView, type Report, type Row, type Tot, type TypeKey, type WeekView } from './commitmentApi'
import CommitmentDrawer from './CommitmentDrawer'
import CommitmentModal, { type Open } from './CommitmentModal'
import { Kpis, Loading, Matrix, PayTbl, Score, WkBar } from './parts'
import './commitments.css'

export const CMV = ['Overview', 'Commitments', 'Weekly report', 'Settings'] as const
type View = typeof CMV[number]
const VKEY: Record<View, string> = { Overview: 'overview', Commitments: 'register', 'Weekly report': 'report', Settings: 'settings' }
const KEYV = Object.fromEntries(Object.entries(VKEY).map(([v, k]) => [k, v])) as Record<string, View>

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [d, setD] = useState<T | null>(null), [err, setErr] = useState<string | null>(null), [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setErr(null)
    fn().then(r => { if (alive) setD(r) }).catch(e => { if (alive) setErr(errText(e, 'Could not load commitments')) })
    return () => { alive = false }
  }, [...deps, n]) // eslint-disable-line react-hooks/exhaustive-deps
  return { d, err, retry: () => setN(x => x + 1) }
}

export const LinesTxt = ({ c, types }: { c: CSummary; types: CType[] }) => <>{c.entries.map(e => { const t = types.find(x => x.k === e.k); if (!t) return null
  return <span className="cm8-lt" key={e.k}><Ic n={t.ic} /> {t.money ? inr(e.v) : `${fmtN(e.n)} ${t.s}`}</span> })}</>

/** Single-person totals (prototype cmTot([{...r, mgr: false}])). */
const rowTot = (r: Row, types: CType[]): Tot => Object.fromEntries(types.filter(t => r.ty[t.k]).map(t => { const x = r.ty[t.k] as Cell
  return [t.k, { cv: x.cv, av: x.av, cvv: x.cvv, avv: x.avv, pend: x.pend, p: x.cv > 0 ? Math.round(x.av / x.cv * 100) : null, n: x.cm ? 1 : 0 }] }))

/**
 * The Commitments workspace inside Field Sales 360. `newNonce` changes when the page header's "New commitment" is pressed.
 */
export default function CommitmentsTab({ newNonce }: { newNonce: number }) {
  const [sp, setSp] = useSearchParams()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaErr, setMetaErr] = useState<string | null>(null)
  const [ver, setVer] = useState(0)
  const [modal, setModal] = useState<Open | null>(null)
  const [drawer, setDrawer] = useState<number | null>(null)
  const loadMeta = useCallback(() => { setMetaErr(null); cmApi.meta().then(setMeta).catch(e => setMetaErr(errText(e, 'Could not load commitments'))) }, [])
  useEffect(loadMeta, [loadMeta])
  useEffect(() => { if (newNonce) setModal({}) }, [newNonce])

  const view: View = KEYV[sp.get('cmv') || ''] || 'Overview'
  const pid = Number(sp.get('cmp')) || null
  const week = sp.get('cmw') || undefined
  const team = sp.get('cmt') || 'All'
  const set = (patch: Record<string, string | null>) => setSp(s => { const n = new URLSearchParams(s); Object.entries(patch).forEach(([k, v]) => v == null ? n.delete(k) : n.set(k, v)); return n })
  const bump = () => setVer(v => v + 1)
  const onWeek = (cur: string, from: string) => (d: -7 | 0 | 7) => set({ cmw: d === 0 ? null : addD(from, d) === cur ? null : addD(from, d) })
  const edit = (d: Detail) => { setDrawer(null); setModal({ id: d.id, edit: d.edit }) }

  if (!meta) return <Loading err={metaErr} retry={loadMeta} />
  const body = view === 'Overview' ? (pid
    ? <PersonTab key={pid} id={pid} week={week} ver={ver} meta={meta} onBack={() => set({ cmp: null })} onWeek={onWeek} onNew={o => setModal({ owner: o })} onOpen={setDrawer} />
    : <Overview week={week} team={team} ver={ver} meta={meta} onTeam={t => set({ cmt: t === 'All' ? null : t })} onWeek={onWeek}
      onPick={r => set({ cmp: String(r.id) })} onNew={o => setModal({ owner: o })} onOpen={setDrawer} />)
    : view === 'Commitments' ? <Register ver={ver} meta={meta} onOpen={setDrawer} />
    : view === 'Weekly report' ? <ReportTab ver={ver} meta={meta} />
    : <SettingsTab meta={meta} onChanged={() => { loadMeta(); bump() }} />
  return <>
    <div style={{ marginBottom: 12 }}><div className="seg8" role="tablist">{CMV.map(v => <button key={v} type="button" role="tab" aria-selected={v === view} className={v === view ? 'on' : ''}
      onClick={() => set({ cmv: v === 'Overview' ? null : VKEY[v], cmp: null })}>{v}</button>)}</div></div>
    {body}
    {modal && <CommitmentModal meta={meta} open={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); bump() }} />}
    {drawer != null && <CommitmentDrawer id={drawer} onClose={() => setDrawer(null)} onChanged={bump} onEdit={edit} />}
  </>
}

// ─── Overview ─────────────────────────────────────────────────────────────────
type WeekNav = (cur: string, from: string) => (d: -7 | 0 | 7) => void
function Overview({ week, team, ver, meta, onTeam, onWeek, onPick, onNew, onOpen }: {
  week?: string; team: string; ver: number; meta: Meta; onTeam: (t: string) => void; onWeek: WeekNav; onPick: (r: Row) => void; onNew: (owner: number) => void; onOpen: (id: number) => void
}) {
  const { success, error } = useToast()
  const { d, err, retry } = useLoad<WeekView>(() => cmApi.week(week, team), [week, team, ver])
  const [busy, setBusy] = useState<number | null>(null)
  if (!d) return <Loading err={err} retry={retry} />
  const pace = d.week.pace
  const remind = async (id: number, n: string) => {
    setBusy(id)
    try { const r = await cmApi.remind([id], d.week.from); r.sent ? success(`Reminder sent to ${n}`, `Submit before ${d.cutoff}`) : error('Reminder not sent', `${n} has switched these notifications off`) }
    catch (e) { error('Reminder not sent', errText(e)) } finally { setBusy(null) }
  }
  return <>
    <div className="cm8-bar"><WkBar week={d.week} onMove={onWeek(d.week.current, d.week.from)} />
      <div className="row wrap" style={{ gap: 6 }}><span role="button" tabIndex={0} className={`chip ${team === 'All' ? 'on' : ''}`} onClick={() => onTeam('All')}>All teams</span>
        {d.teams.map(t => <span key={t} role="button" tabIndex={0} className={`chip ${team === t ? 'on' : ''}`} onClick={() => onTeam(t)}>{t}</span>)}</div>
      <span className="fl" /><small className="mu">{pace != null ? `Week in progress – the marker on each bar shows where you should be by today (${pace}%). ` : ''}Monthly, quarterly and yearly commitments are converted to this week pro-rata.</small></div>
    <Kpis tot={d.tot} types={d.types} rows={d.rows} pace={pace} />
    <div className="panel mb"><div className="ph">Commitment vs achievement · team and individual<span className="fl" /><small className="mu">achieved / committed · click a person for their detail</small></div>
      <div className="pb z"><Matrix rows={d.rows} types={d.types} agg={d.agg} onPick={onPick} /></div></div>
    <div className="g g2" style={{ alignItems: 'start' }}>
      <div className="panel"><div className="ph"><Ic n="wallet" /> Payment commitments this week<span className="fl" /><small className="mu">{d.pay.length} · {inr(d.pay_total)}</small></div>
        <div className="pb z"><PayTbl L={d.pay.slice(0, 10)} showPer empty="No payment commitments for this week" onOpen={onOpen} /></div></div>
      <div className="panel"><div className="ph"><Ic n="bell" /> Not submitted for this week<span className="fl" /><small className="mu">cut-off {d.cutoff}</small></div>
        <div className="list">{d.missing.length ? d.missing.map(r => <div key={r.id}><Av name={r.n} /><span className="fl"><b>{r.n}</b><br /><small className="mu">{r.tk}</small></span>
          {meta.can.manage && r.id !== meta.me.id && <button type="button" className="btn s" disabled={busy === r.id} onClick={() => remind(r.id, r.n)}>Remind</button>}
          {(meta.can.others || r.id === meta.me.id) && <button type="button" className="btn s p" onClick={() => onNew(r.id)}>{r.id === meta.me.id ? 'Enter now' : 'Enter for them'}</button>}</div>)
          : <div className="empty">Everyone has committed for this week</div>}</div></div>
    </div>
  </>
}

// ─── person (prototype cmPerson) ──────────────────────────────────────────────
function PersonTab({ id, week, ver, meta, onBack, onWeek, onNew, onOpen }: {
  id: number; week?: string; ver: number; meta: Meta; onBack: () => void; onWeek: WeekNav; onNew: (owner: number) => void; onOpen: (id: number) => void
}) {
  const { d, err, retry } = useLoad<PersonView>(() => cmApi.person(id, week), [id, week, ver])
  if (!d) return <><div className="row mb"><a onClick={onBack}>‹ All people</a></div><Loading err={err} retry={retry} /></>
  const p = d.person, r = d.row, can = meta.can.others || id === meta.me.id
  return <>
    <div className="row mb wrap" style={{ gap: 10 }}><a onClick={onBack}>‹ All people</a><span className="fl" /><WkBar week={d.week} onMove={onWeek(d.week.current, d.week.from)} />
      {can && <button type="button" className="btn p" onClick={() => onNew(id)}><Ic n="plus" /> New commitment for {first(p.name)}</button>}</div>
    <div className="cm8-who"><Av name={p.name} /><div><h2>{p.name}</h2><span className="mu">{p.team} · annual target {inr(p.target)}</span></div><span className="fl" /><Score s={r?.score} /></div>
    {r && <Kpis tot={rowTot(r, d.types)} types={d.types} rows={[{ ...r, mgr: false }]} pace={d.week.pace} />}
    <div className="g g2 mb" style={{ alignItems: 'start' }}>
      <Panel title="Score · last 8 weeks"><Line ser={[{ n: 'Score %', c: PAL[0], v: d.hist.map(h => h.score ?? 0) }]} labels={d.hist.map(h => h.w)} h={150} f={v => `${Math.round(v)}%`} /></Panel>
      <Panel title="Payments · committed vs collected"><Line ser={[{ n: 'Committed (₹ L)', c: PAL[1], v: d.hist.map(h => lakh(h.pay_cv)), fill: false }, { n: 'Collected (₹ L)', c: PAL[2], v: d.hist.map(h => lakh(h.pay_av)) }]} labels={d.hist.map(h => h.w)} h={150} /></Panel>
    </div>
    <Panel title={<>Commitments<span className="fl" /><small className="mu">{d.commitments.length}</small></>} z>
      <Tbl rows={d.commitments} onRow={c => onOpen(c.id)} empty="No commitments yet" cols={[
        { k: 'label', t: 'Period', fn: c => <><a><b>{c.label}</b></a>{c.cover && <> <span className="pill ac">covers this week</span></>}</> },
        { k: 'per', t: 'Type', fn: c => <Pill s={c.per} t="mu" /> }, { k: 'l', t: 'Entries', fn: c => <LinesTxt c={c} types={d.types} /> },
        { k: 'sub', t: 'Submitted', fn: c => fd(c.submitted) }, { k: 'status', t: 'Status', fn: c => <Pill s={c.status} t={stTone(c.status)} /> },
      ]} /></Panel>
  </>
}

// ─── Commitments register ─────────────────────────────────────────────────────
function Register({ ver, meta, onOpen }: { ver: number; meta: Meta; onOpen: (id: number) => void }) {
  const { d, err, retry } = useLoad(cmApi.register, [ver])
  const types = d?.types ?? []
  const cols = useMemo<GridCol<CSummary>[]>(() => [
    { k: 'code', t: 'ID', w: 130, fn: c => <b>{c.code}</b>, txt: c => c.code },
    { k: 'owner', t: 'By', w: 180, fn: c => <span className="avn"><Av name={c.owner} />{c.owner}</span>, txt: c => c.owner },
    { k: 'team', t: 'Team', w: 150 },
    { k: 'per', t: 'Type', w: 100, fn: c => <Pill s={c.per} t={c.scope === 'team' ? 'inf' : 'mu'} />, txt: c => c.per },
    { k: 'label', t: 'Period', w: 220 },
    { k: 'lines', t: 'Entries', w: 320, fn: c => <LinesTxt c={c} types={types} />, txt: c => `${c.n_entries} entries` },
    { k: 'pay', t: 'Payments committed', r: true, w: 140, money: true, sum: true, sv: c => c.pay, fn: c => inr(c.pay), txt: c => String(c.pay) },
    { k: 'target', t: 'Period target', r: true, w: 120, money: true, sv: c => c.target, fn: c => inr(c.target), txt: c => String(c.target) },
    { k: 'submitted', t: 'Submitted', w: 110, date: true, fn: c => fd(c.submitted), txt: c => c.submitted || '' },
    { k: 'status', t: 'Status', w: 120, fn: c => <Pill s={c.status} t={stTone(c.status)} />, txt: c => c.status },
  ], [types])
  if (!d) return <Loading err={err} retry={retry} />
  return <>
    <div className="row mb"><span className="mu">{d.rows.length} commitments · every period type, kept as entered – reports convert them to weeks</span><span className="fl" /></div>
    <div className="panel"><BwGrid id="cm-reg" cols={cols} rows={d.rows} rid={c => String(c.id)} onRow={c => onOpen(c.id)} canExport={meta.can.export} empty="No commitments yet" /></div>
  </>
}

// ─── Weekly report ────────────────────────────────────────────────────────────
type Flat = { id: string; wk: string; n: string; team: string; sub: string; score: number | null } & Record<string, number | string | null>
function ReportTab({ ver, meta }: { ver: number; meta: Meta }) {
  const [N, setN] = useState(8), [mt, setMt] = useState<'score' | TypeKey>('score'), [g, setG] = useState<'Individual' | 'Team'>('Individual')
  const { d, err, retry } = useLoad<Report>(() => cmApi.report(N), [N, ver])
  const types = d?.types ?? []
  const tcol = types.find(t => t.k === mt)
  const flatCols = useMemo<GridCol<Flat>[]>(() => [
    { k: 'wk', t: 'Week', w: 190 }, { k: 'n', t: 'Person', w: 170, fn: o => <span className="avn"><Av name={o.n} />{o.n}</span>, txt: o => o.n }, { k: 'team', t: 'Team', w: 150 },
    { k: 'sub', t: 'Committed', w: 90 },
    ...types.flatMap(t => [
      { k: `c_${t.k}`, t: `${t.n} · committed`, r: true, w: 120, sum: true, money: t.money, sv: (o: Flat) => Number(o[`c_${t.k}`]) || 0, fn: (o: Flat) => cmFmt(t, Number(o[`c_${t.k}`]) || 0), txt: (o: Flat) => cmFmt(t, Number(o[`c_${t.k}`]) || 0) },
      { k: `a_${t.k}`, t: `${t.n} · achieved`, r: true, w: 120, sum: true, money: t.money, sv: (o: Flat) => Number(o[`a_${t.k}`]) || 0, fn: (o: Flat) => cmFmt(t, Number(o[`a_${t.k}`]) || 0), txt: (o: Flat) => cmFmt(t, Number(o[`a_${t.k}`]) || 0) }] as GridCol<Flat>[]),
    { k: 'score', t: 'Score', r: true, w: 80, sv: o => o.score, fn: o => <Score s={o.score} />, txt: o => o.score == null ? '' : `${o.score}%` },
  ], [types])
  if (!d) return <Loading err={err} retry={retry} />
  const W = d.weeks
  const keyOf = (r: Row) => g === 'Team' ? r.tk : String(r.id)
  const names = [...new Set(W.flatMap(w => w.rows.filter(r => !r.mgr).map(keyOf)))]
  const nameOf = (k: string) => g === 'Team' ? k : (W.flatMap(w => w.rows).find(r => String(r.id) === k)?.n ?? k)
  const val = (w: Report['weeks'][number], k: string): { p: number | null; sub?: boolean; cv?: number; av?: number } | null => {
    if (g === 'Team') { const a: Agg | undefined = w.agg.find(x => x.tk === k); if (!a) return null; return mt === 'score' ? { p: a.score } : a.ty[mt] ? { ...a.ty[mt]! } : null }
    const r = w.rows.find(x => !x.mgr && keyOf(x) === k); if (!r) return null
    return mt === 'score' ? { p: r.score, sub: r.sub } : r.ty[mt] ? { ...r.ty[mt]! } : null
  }
  const tr = W.map(w => mt === 'score' ? { c: 100, a: w.overall } : { c: w.tot[mt]?.cv ?? 0, a: w.tot[mt]?.av ?? 0 })
  const flat: Flat[] = []
  W.forEach(w => w.rows.filter(r => !r.mgr).forEach(r => { const o: Flat = { id: `${w.from}-${r.id}`, wk: w.label, n: r.n, team: r.tk, sub: r.sub ? 'Yes' : 'No', score: r.score }
    types.forEach(t => { o[`c_${t.k}`] = r.ty[t.k]?.cv ?? 0; o[`a_${t.k}`] = r.ty[t.k]?.av ?? 0 }); flat.push(o) }))
  flat.reverse()
  return <>
    <div className="cm8-bar"><div className="row wrap" style={{ gap: 10 }}>
      <label className="row" style={{ gap: 6 }}>Weeks <select className="in sm" style={{ width: 80 }} value={N} onChange={e => setN(Number(e.target.value))}>{[4, 8, 13].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
      <label className="row" style={{ gap: 6 }}>Show <select className="in sm" style={{ width: 190 }} value={mt} onChange={e => setMt(e.target.value as typeof mt)}><option value="score">Overall score</option>{types.map(t => <option key={t.k} value={t.k}>{t.n}</option>)}</select></label>
      <div className="seg8">{(['Individual', 'Team'] as const).map(x => <button key={x} type="button" className={g === x ? 'on' : ''} onClick={() => setG(x)}>{x}</button>)}</div></div>
      <span className="fl" /><small className="mu">Every commitment converted to weekly – a monthly commitment of 20 leads counts ≈ 4.5 a week</small></div>
    <div className="g g2 mb" style={{ alignItems: 'start' }}>
      <Panel title={mt === 'score' ? 'Overall score by week' : `${tcol?.n} · committed vs achieved`}>
        <Line ser={mt === 'score' ? [{ n: 'Score %', c: PAL[0], v: tr.map(x => x.a) }] : [{ n: 'Committed', c: PAL[1], v: tr.map(x => tcol?.money ? lakh(x.c) : x.c), fill: false }, { n: 'Achieved', c: PAL[2], v: tr.map(x => tcol?.money ? lakh(x.a) : x.a) }]}
          labels={W.map(w => w.w)} h={170} f={mt === 'score' ? v => `${Math.round(v)}%` : tcol?.money ? v => `₹${Math.round(v)}L` : undefined} /></Panel>
      <Panel title="Commitment compliance by week"><Bars d={W.map(w => { const s = w.rows.filter(r => !r.mgr), v = pctOf(s.filter(r => r.sub).length, s.length); return { l: w.w, v, c: pc3(v) } })} h={170} f={v => `${Math.round(v)}%`} /></Panel>
    </div>
    <div className="panel mb"><div className="ph">{g === 'Team' ? 'Teams' : 'People'} × week · {mt === 'score' ? 'overall score' : `${tcol?.n.toLowerCase()} – achieved vs committed`}</div>
      <div className="pb z">{!names.length ? <div className="empty">No one in your team gives commitments</div> : <div className="tw fit"><table className="t cm8-wt"><thead><tr><th>{g === 'Team' ? 'Team' : 'Person'}</th>
        {W.map(w => <th key={w.from} className="c">{w.w}<br /><small className="mu">{w.short}</small></th>)}<th className="c">Average</th></tr></thead>
        <tbody>{names.map(k => { const cells = W.map(w => val(w, k)), ps = cells.map(x => x && x.p != null ? x.p : null).filter((p): p is number => p != null)
          const avg = ps.length ? Math.round(ps.map(p => Math.min(p, 150)).reduce((a, b) => a + b, 0) / ps.length) : null, nm = nameOf(k)
          return <tr key={k}><td>{g === 'Team' ? <b>{nm}</b> : <span className="row" style={{ gap: 6 }}><Av name={nm} />{nm}</span>}</td>
            {cells.map((x, i) => !x || x.p == null ? <td key={i} className="c"><span className="cm8-h0">{x && x.sub === false ? 'no commitment' : '—'}</span></td>
              : <td key={i} className="c"><span className="cm8-h" style={{ ['--c' as string]: pc3(x.p) }}>{x.p}%</span>{mt !== 'score' && x.cv !== undefined && <><br /><small className="mu">{cmFmt(tcol, x.av ?? 0)} / {cmFmt(tcol, x.cv)}</small></>}</td>)}
            <td className="c"><Score s={avg} /></td></tr> })}</tbody></table></div>}</div></div>
    <div className="panel"><div className="ph">Data · person × week<span className="fl" /><small className="mu">Export for the management pack</small></div>
      <BwGrid id="cm-wk" cols={flatCols} rows={flat} rid={o => o.id} canExport={meta.can.export} empty="No data for these weeks" /></div>
  </>
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function SettingsTab({ meta, onChanged }: { meta: Meta; onChanged: () => void }) {
  const { success, error } = useToast()
  const s = meta.settings, can = meta.can.settings
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (patch: Partial<typeof s>, msg: string) => {
    setBusy(true)
    try { await cmApi.saveSettings(patch); success(msg); onChanged() } catch (e) { error('Setting not saved', errText(e)) } finally { setBusy(false) }
  }
  const toggle = <T,>(L: T[], v: T, on: boolean) => on ? [...new Set([...L, v])] : L.filter(x => x !== v)
  const addTeam = async () => {
    if (!name.trim()) return error('Name the team')
    setBusy(true)
    try { await cmApi.addTeam(name.trim()); success(`Team “${name.trim()}” added`); setName(''); onChanged() } catch (e) { error('Team not added', errText(e)) } finally { setBusy(false) }
  }
  const move = async (uid: number, n: string, v: string) => {
    setBusy(true)
    try { const r = await cmApi.setTeam(uid, v ? Number(v) : null); success(`${n} moved to ${r.team}`); onChanged() } catch (e) { error('Team not changed', errText(e)) } finally { setBusy(false) }
  }
  const members = meta.people.filter(p => !p.head)
  const heads = meta.people.filter(p => p.head).map(p => p.name)
  return <>
    {!can && <div className="note mb">Only a Sales Head or an administrator can change these settings.</div>}
    <div className="g g2" style={{ alignItems: 'start' }}>
      <div className="panel"><div className="ph">What people commit to<span className="fl" /><small className="mu">Follows the business flow · {meta.flow}</small></div>
        <div className="list">{meta.types.map(t => <div key={t.k}><span className="cm8-ki"><Ic n={t.ic} /></span>
          <div className="fl"><b>{t.n}</b><br /><small className="mu">{t.flow ? t.h : `Off – ${t.mod_label} is not used in this company’s business flow`}</small></div>
          {t.flow ? <Switch on={s.types[t.k] !== false} disabled={!can || busy} label={t.n} onChange={v => save({ types: { ...s.types, [t.k]: v } }, `${t.n}${v ? ' added to' : ' removed from'} commitments`)} />
            : <Pill s="Not in flow" t="mu" />}</div>)}</div>
        <div className="pb"><small className="mu">Change the business flow in Process Designer → Sales flow. Commitment types appear or disappear automatically.</small></div></div>
      <div className="g" style={{ alignContent: 'start' }}>
        <div className="panel"><div className="ph">Rules</div><div className="list">
          <div><span className="fl">Who gives commitments</span><span>{meta.roles.map(r => <label key={r} className="row" style={{ display: 'inline-flex', marginLeft: 8, gap: 4 }}>
            <input type="checkbox" disabled={!can || busy} checked={s.roles.includes(r)} onChange={e => save({ roles: toggle(s.roles, r, e.target.checked) }, 'Who gives commitments updated')} /> {r}</label>)}</span></div>
          <div><span className="fl">Periods allowed</span><span>{meta.periods.map(p => <label key={p} className="row" style={{ display: 'inline-flex', marginLeft: 8, gap: 4 }}>
            <input type="checkbox" disabled={!can || busy} checked={s.periods.includes(p)} onChange={e => save({ periods: toggle(s.periods, p, e.target.checked) }, 'Periods allowed updated')} /> {p}</label>)}</span></div>
          <div><span className="fl">Weekly cut-off</span><select className="in sm" style={{ width: 170 }} disabled={!can || busy} value={s.cutoff} onChange={e => save({ cutoff: e.target.value }, `Cut-off set to ${e.target.value}`)}>
            {meta.cutoffs.map(c => <option key={c}>{c}</option>)}</select></div>
          <div><span className="fl">Payments must name a tender (or an old tender)</span><Switch on={s.pay_tender} disabled={!can || busy} label="Payments must name a tender" onChange={v => save({ pay_tender: v }, v ? 'Payments must name a tender' : 'Tender is optional for payments')} /></div>
          <div><span className="fl">Remind people who have not committed</span><Switch on={s.remind} disabled={!can || busy} label="Remind people who have not committed" onChange={v => save({ remind: v }, v ? 'Reminders on' : 'Reminders off')} /></div>
        </div></div>
        <div className="panel"><div className="ph">Teams<span className="fl" /><small className="mu">Used to roll up the management report{heads.length ? ` · led by ${heads.join(', ')}` : ''}</small></div>
          <div className="list">{members.length ? members.map(p => <div key={p.id}><Av name={p.name} /><span className="fl">{p.name}</span>
            <select className="in sm" style={{ width: 170 }} disabled={!can || busy} value={p.team_id ?? ''} aria-label={`Team for ${p.name}`} onChange={e => move(p.id, p.name, e.target.value)}>
              {meta.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}<option value="">Unassigned</option></select></div>)
            : <div className="empty">No one in your team gives commitments</div>}</div>
          {can && <div className="pb"><div className="row" style={{ gap: 6 }}><input className="in sm" placeholder="New team name" maxLength={120} value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTeam() }} />
            <button type="button" className="btn s" disabled={busy} onClick={addTeam}><Ic n="plus" /> Add team</button></div></div>}</div>
      </div>
    </div>
  </>
}
