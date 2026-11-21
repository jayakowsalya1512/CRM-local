// Process Designer – prototype v17 R.workflow (v2) + the flow manager wrapper (line ~2849):
//   "Sales flows" panel (lead / deal / tender flow cards) · page header (company · vN draft · Apply bid template · Publish) ·
//   flowMap (sales-flow presets, object nodes with on/off switches, conversion-rule arrows, "Lead converts to") ·
//   Terminology + Workflows side list · Approval map · Stages table (drag / arrows, SLA, win %, forecast, gate, owner, checklist,
//   exit criteria, on entering) with Add stage.  Every edit saves at once (prototype "changes apply instantly").
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Panel, Pill } from '@/pages/customers/kit'
import { errMsg, inr, processApi, type Appr, type Conv, type Flow, type Obj, type Overview, type Policy, type Stage } from './processApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './process.css'

const Sw = ({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) => (
  <label className="sw"><input type="checkbox" checked={on} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.checked)} /><i /></label>
)
const OBJS: Obj[] = ['leads', 'opps', 'tenders', 'quotes', 'wo']
const DEF_NAMES: Record<Obj, string> = { leads: 'Leads', opps: 'Deals', tenders: 'Bids & Tenders', quotes: 'Quotes', wo: 'Orders & Projects' }
/** prototype FLOWP – sales-flow presets */
const FLOWP: { n: string; d: string; m: Record<Obj, 0 | 1>; to: string }[] = [
  { n: 'Lead → Tender', d: 'Leads convert straight into tenders', m: { leads: 1, opps: 0, tenders: 1, quotes: 0, wo: 0 }, to: 'tenders' },
  { n: 'Lead → Tender → Order', d: 'Direct tender flow with order tracking', m: { leads: 1, opps: 0, tenders: 1, quotes: 0, wo: 1 }, to: 'tenders' },
  { n: 'Lead → Deal → Tender', d: 'Qualify as a deal, then bid', m: { leads: 1, opps: 1, tenders: 1, quotes: 0, wo: 1 }, to: 'opps' },
  { n: 'Lead → Deal → Quotation', d: 'Qualify as a deal, then quote', m: { leads: 1, opps: 1, tenders: 0, quotes: 1, wo: 1 }, to: 'opps' },
  { n: 'Lead → Quotation → Order', d: 'Quote straight from a lead', m: { leads: 1, opps: 0, tenders: 0, quotes: 1, wo: 1 }, to: 'quotes' },
  { n: 'Lead → Deal → Tender / Quotation → Order', d: 'Full flow with both paths', m: { leads: 1, opps: 1, tenders: 1, quotes: 1, wo: 1 }, to: 'opps' },
  { n: 'Deal-first (no leads)', d: 'Start directly with deals', m: { leads: 0, opps: 1, tenders: 1, quotes: 1, wo: 1 }, to: 'opps' },
]
const FLOBJN: Record<'leads' | 'opps' | 'tenders', string> = { leads: 'Lead flows', opps: 'Deal flows', tenders: 'Tender & bid flows' }
const CREATES: [string, string][] = [['tenders', 'Create a bid / tender'], ['quotes', 'Create a quote'], ['wo', 'Create an order'], ['none', 'Nothing']]
const uid = () => 'n' + Math.random().toString(36).slice(2, 9)

type ModalState =
  | { t: 'conv'; k: 'lead' | 'opp' | 'tender' }
  | { t: 'appr'; key: string; i: number; cfg: Appr; existing: boolean }
  | { t: 'policies'; items: Policy[] }
  | { t: 'pipeNew' } | { t: 'flNew'; obj: Obj } | { t: 'flRen'; key: string } | { t: 'olNew' }
  | { t: 'confirm'; title: string; body: ReactNode; ok: string; danger?: boolean; fn: () => Promise<void> | void }

export default function ProcessDesignerPage() {
  const { success, error, info } = useToast()
  const [ov, setOv] = useState<Overview | null>(null)
  const [key, setKey] = useState('tender')
  const [modal, setModal] = useState<ModalState | null>(null)
  const [tpl, setTpl] = useState('')
  const busy = useRef(false)
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)

  const reload = useCallback(() => processApi.overview().then(setOv).catch(e => error(errMsg(e, 'Could not load the Process Designer'))), [error])
  useEffect(() => { reload() }, [reload])
  // Approvals → "Approval policies" opens the stage approval policies directly (/workflow?policies=1)
  const [sp, setSp] = useSearchParams()
  useEffect(() => {
    if (sp.get('policies') !== '1') return
    processApi.policies().then(r => setModal({ t: 'policies', items: r.items })).catch(e => error(errMsg(e)))
    setSp(s => { const n = new URLSearchParams(s); n.delete('policies'); return n }, { replace: true })
  }, [sp, setSp, error])

  const flows = ov?.flows || []
  const flow = flows.find(f => f.key === key) || flows.find(f => f.key === 'tender') || flows[0]
  const can = !!ov?.can_manage
  const nm = (k: Obj) => (ov?.names[k]?.[0]) || DEF_NAMES[k]
  const on = (k: Obj) => ov?.objects[k] !== false
  const roles = ov?.roles || []
  const recs = (k: Obj) => ov?.records[k] ?? 0

  /** run a write, toast, then refresh from the server (the server is the source of truth) */
  const act = async (msg: string, fn: () => Promise<unknown>, after?: () => void) => {
    if (busy.current) return
    busy.current = true
    try { await fn(); await reload(); if (msg) success(msg); after?.() } catch (e) { error(errMsg(e)); await reload() } finally { busy.current = false }
  }
  const setStages = (stages: Stage[], msg: string) => {
    if (!flow) return
    setOv(o => o && ({ ...o, flows: o.flows.map(f => (f.key === flow.key ? { ...f, stages } : f)) }))    // optimistic
    void act(msg, () => processApi.saveFlow(flow.key, stages))
  }
  const patchStage = (i: number, patch: Partial<Stage>, msg: string) => flow && setStages(flow.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)), msg)

  if (!ov || !flow) return <div className="bwi"><div className="empty">Loading…</div></div>

  const opens = flow.stages.filter(s => s.kind === 'open')
  const isOpp = flow.obj === 'opps'
  const wfLabel = (f: Flow) => f.label
  const flowOf = () => FLOWP.find(f => OBJS.every(k => !!f.m[k] === on(k)))?.n || 'Custom flow'

  /* ── flow manager (prototype flowsOf / flNew / flDef / flRen / flDel) ── */
  const flowsOf = (obj: 'leads' | 'opps' | 'tenders') => flows.filter(f => f.obj === obj && !f.lifecycle)
  const col = (obj: 'leads' | 'opps' | 'tenders') => <div className="flcol" key={obj}>
    <div className="flch"><b>{FLOBJN[obj]}</b><span className="pill mu">{flowsOf(obj).length}</span><span className="fl" />
      <button type="button" className="btn s p" disabled={!can || obj !== 'opps'} title={obj === 'opps' ? undefined : 'One flow per company for this object in this release'}
        onClick={() => setModal({ t: 'flNew', obj })}><Ic n="plus" /> Add flow</button></div>
    {flowsOf(obj).map(f => { const o = f.stages.filter(s => s.kind === 'open'); const def = obj === 'opps' ? !!f.default : true
      return <div key={f.key} className={`flcard ${key === f.key ? 'on' : ''}`}>
        <div className="row" style={{ gap: 6 }}><b className="fl">{f.name || f.label}</b>{def && <span className="pill ok" title={`Used automatically for ${f.biz || 'new records'}`}>default</span>}</div>
        <div className="row wrap mt" style={{ gap: 4 }}>{f.biz && <span className="pill ac">{f.biz}</span>}{f.dtype && <span className="pill inf">{f.dtype}-led</span>}
          <span className="pill mu">{o.length} stages</span><span className="pill mu">{f.stages.reduce((a, s) => a + s.n, 0)} records</span></div>
        <div className="flst">{o.map((s, i) => <span key={s.id}>{i > 0 && <i>›</i>}{s.name}</span>)}</div>
        <div className="row mt" style={{ gap: 6 }}>
          <button type="button" className="btn s" onClick={() => setKey(f.key)}><Ic n="file" /> Edit stages</button>
          {obj === 'opps' && !def && <button type="button" className="btn s" disabled={!can} onClick={() => act(`“${f.name}” is now the default`, () => processApi.patchPipeline(f.key, { default: true }))}>Make default</button>}
          {obj === 'opps' && <button type="button" className="btn s g" disabled={!can} onClick={() => setModal({ t: 'flRen', key: f.key })}>Rename</button>}
          {obj === 'opps' && <button type="button" className="btn s g" disabled={!can} onClick={() => {
            if (flowsOf('opps').length <= 1) return info('Keep at least one flow of this kind')
            const n = f.stages.reduce((a, s) => a + s.n, 0)
            setModal({ t: 'confirm', title: 'Delete flow', ok: 'Delete', danger: true, body: <>Delete flow “{f.name}”?{n ? ` Its ${n} records must be moved to another pipeline first.` : ''}</>,
              fn: () => act('Flow deleted', () => processApi.deletePipeline(f.key), () => { if (key === f.key) setKey('tender') }) })
          }}><Ic n="trash" /></button>}
        </div>
      </div> })}
  </div>

  /* ── flowMap ── */
  const node = (k: Obj) => { const f = flows.filter(x => x.obj === k && !x.lifecycle); const steps = k === 'opps' ? `${f.length} pipelines` : `${(f[0]?.stages.filter(s => s.kind === 'open').length) ?? 0} ${k === 'tenders' ? 'steps' : 'stages'}`
    return <div key={k} className={`panel ${on(k) ? '' : 'off'}`}><div className="ph">{nm(k)}<span className="fl" />
      <Sw on={on(k)} disabled={!can} label={`${nm(k)} on / off`} onChange={v => act(`${v ? 'Enabled ' : 'Disabled '}${k}`, () => processApi.saveObjects({ ...ov.objects, [k]: v }))} /></div>
      <div className="pb"><small>{on(k) ? `${steps} · ${recs(k)} records` : 'Off for this company'}</small></div></div> }
  const arr = (k: 'lead' | 'opp' | 'tender', t: string) => <div key={k} className="arr"><span className="mu">→</span><button type="button" className="btn s" onClick={() => setModal({ t: 'conv', k })}>{t}</button></div>
  const mid = (['tenders', 'quotes'] as Obj[]).filter(on)
  const chain: ReactNode[] = []
  if (on('leads')) { chain.push(node('leads')); const tgt = on('opps') ? 'Deal' : on('tenders') && on('quotes') ? 'Bid / quote' : on('tenders') ? 'Tender' : on('quotes') ? 'Quote' : 'Order'; chain.push(arr('lead', 'Lead → ' + tgt)) }
  if (on('opps')) { chain.push(node('opps')); if (mid.length) chain.push(arr('opp', 'Deal won →')) }
  if (mid.length) { chain.push(<div key="mid" className="mid">{mid.map(node)}</div>); if (on('wo')) chain.push(arr('tender', 'Won / accepted →')) }
  if (on('wo')) chain.push(node('wo'))
  const off = OBJS.filter(k => !on(k))
  const flowSet = (n: string) => { const f = FLOWP.find(x => x.n === n); if (!f) return
    void act(`Flow set to “${n}”`, async () => { await processApi.saveObjects({ ...ov.objects, ...Object.fromEntries(OBJS.map(k => [k, !!f.m[k]])) }); await processApi.saveConv({ lead: { to: f.to } }) }) }

  /* ── approval map ── */
  const nAppr = opens.filter(s => s.gate === 'Approval').length
  const chainOf = (s: Stage) => s.appr ? s.appr.chain : [s.owner_role || 'Sales Head']
  const openAppr = (i: number) => { const s = flow.stages[i]; setModal({ t: 'appr', key: flow.key, i, existing: !!s.appr, cfg: s.appr ? { ...s.appr, chain: [...s.appr.chain] } : { chain: [s.owner_role || roles[0] || 'Sales Head'], min: 0, sla: 24, auto: true } }) }

  /* ── stages table actions (prototype wfadd / wfdel / wfup / wfdn / wfMove) ── */
  const wfadd = () => { const L = flow.stages; const i = L.findIndex(s => s.kind !== 'open'); let n = 'New stage', c = 1; while (L.find(s => s.name === n)) n = 'New stage ' + (++c)
    const ns: Stage = { id: uid(), name: n, kind: 'open', sla: 3, gate: 'None', owner_role: '', checklist: [], exit: '', auto: '', forecast: null, appr: null, n: 0, prob: isOpp ? 50 : null }
    const next = [...L]; next.splice(i < 0 ? L.length : i, 0, ns); setStages(next, 'Stage added') }
  const wfdel = (i: number) => { const s = flow.stages[i]; if (opens.length <= 2) return info('A pipeline needs at least two open stages')
    setModal({ t: 'confirm', title: 'Delete stage', ok: 'Delete stage', danger: true, body: <>Delete “{s.name}”?{s.n ? ` ${s.n} record(s) are in it – move them first.` : ' Records in it move to the previous stage.'}</>,
      fn: () => { setModal(null); setStages(flow.stages.filter((_, j) => j !== i), 'Stage removed') } }) }
  const wfSwap = (a: number, b: number) => { const L = [...flow.stages]; if (!L[a] || !L[b] || L[a].kind !== 'open' || L[b].kind !== 'open') return; [L[a], L[b]] = [L[b], L[a]]; setStages(L, 'Stages reordered') }
  const wfMove = (from: number, to: number) => { const L = [...flow.stages]; const lim = L.findIndex(s => s.kind !== 'open'); const t = Math.min(to, lim < 0 ? L.length - 1 : lim - 1); const [m] = L.splice(from, 1); L.splice(t, 0, m); setStages(L, 'Stages reordered') }
  const editable = can && !flow.fixed
  const wfTpl = (v: string) => { setTpl(''); if (!v) return; if (flow.key !== 'tender') return info('Templates apply to the Tender lifecycle')
    const t = ov.templates.find(x => x.k === v)
    setModal({ t: 'confirm', title: 'Apply bid template', ok: 'Apply', body: <>Replace the tender lifecycle with “{t?.l}”? Records in removed stages move to the nearest stage.</>,
      fn: () => { setModal(null); void act('Template applied', () => processApi.applyTemplate(v)) } }) }

  return <div className="bwi">
    {/* flow manager (prototype inserts it before everything else) */}
    <div className="panel mb"><div className="ph"><Ic n="flow" /> Sales flows <span className="fl" /><small>A company can sell in many ways at once – B2B, B2C, institutional, partner – each record follows its own flow</small></div>
      <div className="pb"><div className="flgrid">{col('leads')}{col('opps')}{col('tenders')}</div>
        <div className="note inf mt">Records pick a flow automatically from their business model (leads), deal type + model (deals) or the tender's evaluation method – or you choose it on the record. Edit stages, gates and SLAs of any flow below.</div></div></div>

    <div className="pg"><div><div className="crumb">Administration</div><h1>Process designer</h1></div>
      <span className="cnt">{ov.company} · v{ov.published.version} draft</span><span className="fl" />
      <select className="in" value={tpl} disabled={!can} aria-label="Apply bid template" onChange={e => wfTpl(e.target.value)}><option value="">Apply bid template…</option>{ov.templates.map(t => <option key={t.k} value={t.k}>{t.l}</option>)}</select>
      <button type="button" className="btn p" disabled={!can} onClick={() => act('', () => processApi.publish(), () => success('Workflow published – all users see the new steps now'))}>Publish changes</button></div>

    {/* flowMap */}
    <Panel className="mb" title="Sales flow · choose the steps this company uses">
      <div className="row wrap mb" style={{ gap: 6 }}>{FLOWP.map(f => <span key={f.n} role="button" tabIndex={0} title={f.d} className={`chip ${flowOf() === f.n ? 'on' : ''}`} onClick={() => can && flowSet(f.n)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (can) flowSet(f.n) } }}>{f.n}</span>)}<span className={`chip ${flowOf() === 'Custom flow' ? 'on' : ''}`}>Custom</span></div>
      <div className="fmap">{chain}</div>
      {off.length > 0 && <div className="note mt">Hidden for this company: <b>{off.map(nm).join(', ')}</b>. Their data is kept and can be switched back on at any time.</div>}
      <div className="row mt wrap" style={{ gap: 14 }}><label className="row">Lead converts to <select className="in sm" style={{ width: 150 }} value={ov.conv.lead.to} disabled={!can}
        onChange={e => act('Lead conversion target updated', () => processApi.saveConv({ lead: { to: e.target.value } }))}>{[['opps', 'A deal'], ['tenders', 'A tender'], ['quotes', 'A quote'], ['wo', 'An order']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <small className="mu">Toggle any step above to build a custom flow – the sidebar, quick-create menu and conversion buttons follow immediately.</small></div>
    </Panel>

    <div className="g g2 mb">
      <Panel z title="Terminology · rename objects for your company">
        <table className="t terms"><thead><tr><th>Object</th><th>Plural</th><th>Singular</th></tr></thead><tbody>{ov.object_labels.map(([k, d]) => { const n = ov.names[k] || ['', '']
          return <tr key={k}><td>{d}</td>{[0, 1].map(i => <td key={i}><input className="in sm" disabled={!can} placeholder={i ? d.replace(/s$/, '') : d} defaultValue={n[i] || ''} key={`${k}${i}${n[i]}`}
            onBlur={e => { const v = e.target.value.trim(); if (v === (n[i] || '')) return; const pair: [string, string] = [n[0] || '', n[1] || '']; pair[i] = v
              void act('Terminology saved', () => processApi.saveNames({ ...ov.names, [k]: pair })) }} /></td>)}</tr> })}</tbody></table>
        <div style={{ padding: '6px 10px' }}><small className="mu">Example: call “Deals” → “Opportunities”, or “Bids & Tenders” → “RFx”.</small></div>
      </Panel>
      <Panel z title="Workflows">
        <div className="side">{flows.map(f => <div key={f.key} role="button" tabIndex={0} className={f.key === flow.key ? 'on' : ''} onClick={() => setKey(f.key)} onKeyDown={e => { if (e.key === 'Enter') setKey(f.key) }}>
          <span className="fl">{wfLabel(f)}</span><small>{f.stages.filter(s => s.kind === 'open').length} steps</small>
          {f.lifecycle && can && <a className="x" title="Delete lifecycle" onClick={e => { e.stopPropagation()
            setModal({ t: 'confirm', title: 'Delete lifecycle', ok: 'Delete', danger: true, body: <>Delete lifecycle “{f.name}”? Its contracts move to Project / Supply.</>,
              fn: () => act('Lifecycle deleted', () => processApi.deleteLifecycle(f.key), () => { if (key === f.key) setKey('wo') }) }) }}>✕</a>}
        </div>)}</div>
        <div style={{ padding: 8 }}><button type="button" className="btn s p" disabled={!can} onClick={() => setModal({ t: 'olNew' })}><Ic n="plus" /> New order lifecycle (AMC, service…)</button>
          <div className="mu11">A deal is either <b>Tender</b> or <b>Quote</b> led. Extra steps such as AMC are order lifecycles and are listed under Orders &amp; Projects.</div></div>
      </Panel>
    </div>

    {/* approval map */}
    <div className="panel mb"><div className="ph"><Ic n="lock" /> Approval map · {wfLabel(flow)}<span className="fl" /><small>{nAppr} of {opens.length} stages need approval</small>
      <a onClick={() => processApi.policies().then(r => setModal({ t: 'policies', items: r.items })).catch(e => error(errMsg(e)))}>All policies</a></div>
      <div className="amap">{opens.map((s, i) => { const a = s.gate === 'Approval'; return <span key={s.id} style={{ display: 'contents' }}>{i > 0 && <span className="mu">›</span>}
        <div className={`ac ${a ? 'on' : ''}`}><div className="b">{s.name}</div>{a ? <><div className="ch"><Ic n="lock" size={11} /> {chainOf(s).join(' › ')}</div>
          <small className="mu">{s.appr?.min ? 'if value ≥ ' + inr(s.appr.min) : 'every record'} · SLA {s.appr?.sla || 24}h</small></> : <small className="mu">No approval</small>}</div></span> })}</div></div>

    {/* stages */}
    <div className="panel"><div className="ph">Stages · {wfLabel(flow)}<span className="fl" /><small>{flow.stages.reduce((a, s) => a + s.n, 0)} records · {flow.fixed ? 'stage names and order are fixed for this object' : 'drag the handle or use arrows'} · changes apply instantly</small></div>
      <div className="tw fit"><table className="t stg"><thead><tr><th /><th>#</th><th>Stage name</th><th>SLA (days)</th>{isOpp && <><th>Win %</th><th>Forecast</th></>}<th>Gate</th><th>Owner role</th><th>Mandatory checklist</th><th>Exit criteria</th><th>On entering</th><th /></tr></thead>
        <tbody>{flow.stages.map((s, i) => { const t = s.kind === 'open'; const k = `${flow.key}:${s.id}`
          return <tr key={s.id} className={`${drag?.over === i ? 'drop' : ''} ${drag?.from === i ? 'drag' : ''}`}
            onDragOver={e => { if (drag && t && editable) { e.preventDefault(); if (drag.over !== i) setDrag({ ...drag, over: i }) } }}
            onDrop={e => { e.preventDefault(); if (drag && t && editable && drag.from !== i) wfMove(drag.from, i); setDrag(null) }}>
            <td className={`grip ${t && editable ? '' : 'na'}`} draggable={t && editable} onDragStart={() => setDrag({ from: i, over: null })} onDragEnd={() => setDrag(null)}>{t && editable ? <Ic n="grip" /> : null}</td>
            <td>{t ? opens.indexOf(s) + 1 : ''}</td>
            <td><span className="row" style={{ gap: 6 }}><input key={k + s.name} className="in sm" style={{ minWidth: 150 }} defaultValue={s.name} disabled={!editable}
              onBlur={e => { const v = e.target.value.trim(); if (!v) { e.target.value = s.name; return } if (v !== s.name) patchStage(i, { name: v }, 'Stage renamed – records updated') }} />
              {!t && <Pill s={s.kind === 'won' ? 'Won' : 'Lost'} t={s.kind === 'won' ? 'ok' : 'ba'} />}<small>{s.n}</small></span></td>
            <td>{t ? <input key={k + 'sla' + s.sla} className="in sm" type="number" min={0} style={{ width: 58 }} defaultValue={s.sla} disabled={!can}
              onBlur={e => { const v = Math.max(0, +e.target.value || 0); if (v !== s.sla) patchStage(i, { sla: v }, 'SLA updated') }} /> : '—'}</td>
            {isOpp && <><td><input key={k + 'p' + s.prob} className="in sm" type="number" min={0} max={100} style={{ width: 58 }} defaultValue={s.prob ?? 0} disabled={!t || !can}
              onBlur={e => { const v = Math.max(0, Math.min(100, +e.target.value || 0)); if (v !== (s.prob ?? 0)) patchStage(i, { prob: v }, 'Win % saved') }} /></td>
              <td><select className="in sm" style={{ width: 100 }} value={s.forecast || ''} disabled={!t || !can} onChange={e => patchStage(i, { forecast: e.target.value }, 'Forecast category saved')}>{ov.forecasts.map(f => <option key={f}>{f}</option>)}</select></td></>}
            <td>{t ? <><select className="in sm" style={{ width: 100 }} value={s.gate} disabled={!can} onChange={e => { const g = e.target.value as Stage['gate']
              if (g === 'Approval') { setOv(o => o && ({ ...o, flows: o.flows.map(f => f.key === flow.key ? { ...f, stages: f.stages.map((x, j) => j === i ? { ...x, gate: g } : x) } : f) })); setTimeout(() => openAppr(i), 60) }
              else patchStage(i, { gate: g, appr: null, checklist: g === 'Checklist' ? (s.checklist.length ? s.checklist : ['Item']) : s.checklist }, 'Gate updated') }}>{ov.gates.map(g => <option key={g}>{g}</option>)}</select>
              {s.gate === 'Approval' && <><br /><a className="ap" onClick={() => openAppr(i)}><Ic n="lock" size={11} /> {chainOf(s).join(' › ')}{s.appr?.min ? ' · ≥ ' + inr(s.appr.min) : ''}</a></>}</> : '—'}</td>
            <td>{t ? <select className="in sm" style={{ width: 125 }} value={s.owner_role} disabled={!can} onChange={e => patchStage(i, { owner_role: e.target.value }, 'Owner role saved')}><option value="">Any</option>{roles.map(r => <option key={r}>{r}</option>)}</select> : '—'}</td>
            <td>{s.gate === 'Checklist' ? <input key={k + 'cl' + s.checklist.join(';')} className="in sm" style={{ minWidth: 180 }} defaultValue={s.checklist.join('; ')} placeholder="item; item" disabled={!can}
              onBlur={e => { const v = e.target.value.split(';').map(x => x.trim()).filter(Boolean); if (v.join('|') !== s.checklist.join('|')) patchStage(i, { checklist: v }, 'Checklist saved') }} /> : <span className="mu">—</span>}</td>
            <td>{t && <input key={k + 'x' + s.exit} className="in sm" style={{ minWidth: 150 }} defaultValue={s.exit} placeholder="e.g. Budget confirmed" disabled={!can}
              onBlur={e => { const v = e.target.value.trim(); if (v !== s.exit) patchStage(i, { exit: v }, 'Exit criteria saved') }} />}</td>
            <td>{t && <input key={k + 'a' + s.auto} className="in sm" style={{ minWidth: 140 }} defaultValue={s.auto} placeholder="e.g. Notify KAM" disabled={!can}
              onBlur={e => { const v = e.target.value.trim(); if (v !== s.auto) patchStage(i, { auto: v }, 'Automation saved') }} />}</td>
            <td className="nw">{t && editable && <><button type="button" className="btn g s" disabled={i === 0} onClick={() => wfSwap(i, i - 1)}>↑</button>
              <button type="button" className="btn g s" disabled={i >= opens.length - 1} onClick={() => wfSwap(i, i + 1)}>↓</button>
              <button type="button" className="btn g s" onClick={() => wfdel(i)}><Ic n="trash" /></button></>}</td>
          </tr> })}</tbody></table></div>
      <div style={{ padding: 8 }} className="row"><button type="button" className="btn" disabled={!editable} onClick={wfadd}><Ic n="plus" /> Add stage</button>
        <small className="fl mu">Approval gate raises an approval using the Stage-gate chain. Checklist gate requires every item to be ticked. Win % updates the record’s probability when it enters the stage.</small></div></div>

    {/* ── modals ── */}
    {modal?.t === 'confirm' && <Modal title={modal.title} width={440} onClose={() => setModal(null)}
      foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button><button type="button" className={`btn ${modal.danger ? 'd' : 'p'}`} onClick={() => { const r = modal.fn(); if (r) r.then(() => setModal(null)) }}>{modal.ok}</button></>}>
      <p style={{ margin: 0 }}>{modal.body}</p></Modal>}
    {modal?.t === 'conv' && <ConvModal k={modal.k} ov={ov} can={can} onClose={() => setModal(null)} act={act} />}
    {modal?.t === 'appr' && <ApprModal m={modal} roles={roles} stage={flow.stages[modal.i]} onClose={() => { setModal(null); void reload() }}
      onRemove={() => { setModal(null); patchStage(modal.i, { gate: 'None', appr: null }, 'Approval removed') }}
      onSave={cfg => { setModal(null); patchStage(modal.i, { gate: 'Approval', appr: cfg, owner_role: cfg.chain[0] }, `Approval set at “${flow.stages[modal.i].name}”: ${cfg.chain.join(' › ')}${cfg.min ? ' for values ≥ ' + inr(cfg.min) : ''}`) }} />}
    {modal?.t === 'policies' && <Modal title={<><Ic n="lock" /> Approval policies by stage · {ov.company}</>} width={760} onClose={() => setModal(null)} foot={<><span className="fl" /><button type="button" className="btn p" onClick={() => setModal(null)}>Done</button></>}>
      {modal.items.length ? <table className="t"><thead><tr><th>Pipeline</th><th>Stage</th><th>Approver chain</th><th>Applies when</th><th>SLA</th><th /></tr></thead>
        <tbody>{modal.items.map((r, i) => <tr key={i}><td>{r.p}</td><td><b>{r.s}</b></td><td>{r.c.join(' › ')}</td><td>{r.w ? '≥ ' + inr(r.w) : 'Every record'}</td><td>{r.l} h</td>
          <td><button type="button" className="btn s" onClick={() => { setKey(r.k); setModal(null) }}>Open</button></td></tr>)}</tbody></table>
        : <div className="empty">No stage requires approval yet – set a stage's gate to Approval.</div>}</Modal>}
    {(modal?.t === 'pipeNew' || modal?.t === 'flNew') && <PipeNewModal ov={ov} onClose={() => setModal(null)}
      onCreate={d => act(`Pipeline “${d.name}” created – it now appears under Deals in the sidebar`, () => processApi.createPipeline(d).then(r => setKey(r.key)), () => setModal(null))} />}
    {modal?.t === 'flRen' && <RenModal name={flows.find(f => f.key === modal.key)?.name || ''} onClose={() => setModal(null)}
      onSave={v => act('Flow renamed', () => processApi.patchPipeline(modal.key, { name: v }), () => setModal(null))} />}
    {modal?.t === 'olNew' && <LifecycleModal templates={ov.lc_templates} onClose={() => setModal(null)}
      onCreate={d => act(`“${d.name}” added – it now appears under Orders & Projects in the sidebar`, () => processApi.createLifecycle(d).then(r => setKey(r.key)), () => setModal(null))} />}
  </div>
}

/* ───────────── Conversion rules (prototype convCfg) ───────────── */
function ConvModal({ k, ov, can, onClose, act }: { k: 'lead' | 'opp' | 'tender'; ov: Overview; can: boolean; onClose: () => void; act: (m: string, fn: () => Promise<unknown>) => Promise<void> }) {
  const cv: Conv = ov.conv
  const pipes = ov.flows.filter(f => f.obj === 'opps' && !f.lifecycle)
  const leadFlow = ov.flows.find(f => f.key === 'lead')
  const saveLead = (patch: Record<string, unknown>) => act('Rule saved', () => processApi.saveConv({ lead: patch }))
  return <Modal title="Conversion rules" width={560} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn p" onClick={onClose}>Done</button></>}>
    {k === 'lead' && <><div className="fg">
      <div><label>Convert when lead reaches</label><select className="in" value={cv.lead.stage} disabled={!can} onChange={e => saveLead({ stage: e.target.value })}><option value="">Manual only</option>{leadFlow?.stages.filter(s => s.kind === 'open').map(s => <option key={s.id} value={s.name}>{s.name}</option>)}</select></div>
      <div><label>Create deal in pipeline</label><select className="in" value={cv.lead.type} disabled={!can} onChange={e => saveLead({ type: e.target.value })}>{pipes.map(p => <option key={p.key} value={p.name}>{p.name}</option>)}</select></div>
      <div><label className="row"><Sw on={cv.lead.auto} disabled={!can} onChange={v => saveLead({ auto: v })} /> Convert automatically</label></div>
      <div><label className="row"><Sw on={cv.lead.acct} disabled={!can} onChange={v => saveLead({ acct: v })} /> Create the account if missing</label></div></div>
      <h3 className="mt mb" style={{ fontSize: 13 }}>Field mapping</h3>
      <div className="list bx">{Object.entries(cv.lead.map).map(([f, v]) => <div key={f}><Sw on={!!v} disabled={!can} onChange={x => saveLead({ map: { ...cv.lead.map, [f]: x } })} /><span className="fl">{f}</span></div>)}</div></>}
    {k === 'opp' && <><p className="mu mb">What happens when a deal reaches its Won stage, per pipeline.</p>
      {pipes.map(p => <div key={p.key} className="row mb"><b className="fl">{p.name}</b>
        <select className="in sm" style={{ width: 170 }} value={p.creates} disabled={!can} onChange={e => act('Pipeline rule saved', () => processApi.patchPipeline(p.key, { creates: e.target.value }))}>{CREATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <label className="row"><Sw on={!!p.auto} disabled={!can} onChange={v => act('Pipeline rule saved', () => processApi.patchPipeline(p.key, { auto: v }))} /> Auto</label></div>)}</>}
    {k === 'tender' && <><div className="list bx">
      <div><Sw on={cv.tender.auto} disabled={!can} onChange={v => act('Rule saved', () => processApi.saveConv({ tender: { auto: v } }))} /><span className="fl">Create an order automatically when a bid is Won</span></div>
      <div><Sw on={cv.quote.auto} disabled={!can} onChange={v => act('Rule saved', () => processApi.saveConv({ quote: { auto: v } }))} /><span className="fl">Create an order automatically when a quote is Accepted</span></div></div>
      <p className="mu mt">Order details (PO number, consignees, value) are copied from the bid or quote.</p></>}
  </Modal>
}

/* ───────────── Approval at a stage (prototype apprModal) ───────────── */
function ApprModal({ m, roles, stage, onClose, onSave, onRemove }: { m: { cfg: Appr; existing: boolean }; roles: string[]; stage: Stage; onClose: () => void; onSave: (c: Appr) => void; onRemove: () => void }) {
  const [c, setC] = useState<Appr>(m.cfg)
  const [add, setAdd] = useState('')
  const free = roles.filter(r => !c.chain.includes(r))
  const mv = (i: number, d: number) => setC(x => { const L = [...x.chain]; const j = i + d; if (!L[j]) return x; [L[i], L[j]] = [L[j], L[i]]; return { ...x, chain: L } })
  return <Modal title={<><Ic n="lock" /> Approval at “{stage.name}”</>} width={560} onClose={onClose}
    foot={<>{m.existing && <button type="button" className="btn d" onClick={onRemove}>Remove approval</button>}<span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn p" onClick={() => onSave({ ...c, chain: c.chain.filter(Boolean), min: Math.max(0, c.min), sla: Math.max(1, c.sla) })}>Save approval rule</button></>}>
    <div className="note inf mb">When a record moves <b>into</b> this stage, an approval request is raised. The record waits at its current stage until every approver in the chain approves.</div>
    <label className="lb">Approver chain (in order)</label>
    <div className="list bx">{c.chain.map((r, i) => <div key={r + i}><b className="i">{i + 1}</b><span className="fl">{r}</span>
      <button type="button" className="btn s g" disabled={!i} onClick={() => mv(i, -1)}>↑</button><button type="button" className="btn s g" disabled={i >= c.chain.length - 1} onClick={() => mv(i, 1)}>↓</button>
      <button type="button" className="btn s g" disabled={c.chain.length <= 1} onClick={() => setC(x => ({ ...x, chain: x.chain.filter((_, j) => j !== i) }))}><Ic n="x" /></button></div>)}</div>
    <div className="row mt"><select className="in" style={{ maxWidth: 220 }} value={add || free[0] || ''} onChange={e => setAdd(e.target.value)}>{free.map(r => <option key={r}>{r}</option>)}</select>
      <button type="button" className="btn s" disabled={!free.length} onClick={() => { const v = add || free[0]; if (v) { setC(x => ({ ...x, chain: [...x.chain, v] })); setAdd('') } }}><Ic n="plus" /> Add approver</button></div>
    <div className="fg mt">
      <div><label>Required only when value is at least (₹ lakh)</label><input className="in" type="number" min={0} value={c.min / 1e5} onChange={e => setC(x => ({ ...x, min: Math.max(0, +e.target.value || 0) * 1e5 }))} /><small>0 = every record needs approval</small></div>
      <div><label>Response SLA (hours)</label><input className="in" type="number" min={1} value={c.sla} onChange={e => setC(x => ({ ...x, sla: Math.max(1, +e.target.value || 1) }))} /></div>
      <div className="f1"><label className="row"><input type="checkbox" checked={c.auto !== false} onChange={e => setC(x => ({ ...x, auto: e.target.checked }))} /> Auto-approve records below the threshold</label></div></div>
  </Modal>
}

/* ───────────── New deal pipeline / flow (prototype pipeNew + flNew) ───────────── */
function PipeNewModal({ ov, onClose, onCreate }: { ov: Overview; onClose: () => void; onCreate: (d: { name: string; copy_from: string; creates: string; biz: string; default: boolean }) => void }) {
  const { info } = useToast()
  const pipes = ov.flows.filter(f => f.obj === 'opps' && !f.lifecycle)
  const [d, setD] = useState({ name: '', copy_from: pipes[0]?.key || '', creates: 'tenders', biz: ov.biz[0] || '', default: false })
  return <Modal title="New deal pipeline" width={560} onClose={onClose}
    foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => { if (!d.name.trim()) return info('Name the pipeline'); onCreate({ ...d, name: d.name.trim() }) }}>Create pipeline</button></>}>
    <div className="fg">
      <div className="f1"><label>Pipeline name</label><input className="in" autoFocus placeholder="e.g. Renewal, Channel partner, AMC" value={d.name} onChange={e => setD({ ...d, name: e.target.value })} /></div>
      <div><label>Copy stages from</label><select className="in" value={d.copy_from} onChange={e => setD({ ...d, copy_from: e.target.value })}>{pipes.map(p => <option key={p.key} value={p.key}>Copy of · {p.name}</option>)}</select></div>
      <div><label>When a deal is won, create</label><select className="in" value={d.creates} onChange={e => setD({ ...d, creates: e.target.value })}><option value="tenders">A bid / tender</option><option value="quotes">A quote</option><option value="wo">An order</option><option value="none">Nothing</option></select></div>
      <div><label>Business model</label><select className="in" value={d.biz} onChange={e => setD({ ...d, biz: e.target.value })}>{ov.biz.map(b => <option key={b}>{b}</option>)}</select></div>
      <div className="f1"><label className="row"><input type="checkbox" checked={d.default} onChange={e => setD({ ...d, default: e.target.checked })} /> Make it the default for this business model</label></div>
    </div></Modal>
}

function RenModal({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(name)
  return <Modal title="Rename flow" width={420} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => v.trim() && onSave(v.trim())}>Save</button></>}>
    <input className="in" autoFocus value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && v.trim()) onSave(v.trim()) }} /></Modal>
}

/* ───────────── New order lifecycle (prototype olNew) ───────────── */
function LifecycleModal({ templates, onClose, onCreate }: { templates: string[]; onClose: () => void; onCreate: (d: { name: string; template: string; trigger: string }) => void }) {
  const { info } = useToast()
  const [d, setD] = useState({ name: '', template: templates[0] || '', trigger: 'manual' })
  return <Modal title="New order lifecycle" width={520} onClose={onClose}
    foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => { if (!d.name.trim()) return info('Name the lifecycle'); onCreate({ ...d, name: d.name.trim() }) }}>Create lifecycle</button></>}>
    <div className="note inf mb">Use this for steps that follow an order – for example <b>AMC</b>, service contracts or rentals. They are listed under <b>Orders &amp; Projects</b> and linked to the same customer journey.</div>
    <div className="fg">
      <div className="f1"><label>Name</label><input className="in" autoFocus placeholder="e.g. AMC / Service" value={d.name} onChange={e => setD({ ...d, name: e.target.value })} /></div>
      <div><label>Start from</label><select className="in" value={d.template} onChange={e => setD({ ...d, template: e.target.value })}>{templates.map(t => <option key={t}>{t}</option>)}</select></div>
      <div><label>How is it created?</label><select className="in" value={d.trigger} onChange={e => setD({ ...d, trigger: e.target.value })}>
        <option value="manual">Manually – “Create follow-on” on an order</option><option value="closure">Automatically when a project order closes</option><option value="won">Automatically when a deal is won</option></select></div>
    </div></Modal>
}
