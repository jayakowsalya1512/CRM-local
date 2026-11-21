// Product & Price Books – prototype v18 pxPage(p): product record.
// Crumb Products / <code> · name · status + category badges · code · model · Edit details · Submit for review /
// Move to <next> · Mark <final>; hero (List price · Standard cost · Margin · Used in · Specifications · Last change),
// record-status progress and the lock / change-window signals; tabs Overview | Specifications | Category mapping |
// Pricing | Lifecycle | Change log | Brochure. All data from /api/v1/products/{id}.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { errMsg, fd, fdt, inr, money, productApi, stTone, type Detail, type Mapping, type Meta, type MField, type Spec } from './productApi'
import { EditProductModal, StatusModal, WindowModal } from './ProductForms'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/leads/leads.css'
import './products.css'

const TABS = ['Overview', 'Specifications', 'Category mapping', 'Pricing', 'Lifecycle', 'Change log', 'Brochure'] as const
type Tab = typeof TABS[number]
const Pill = ({ s, t }: { s: string; t: string }) => <span className={`pill ${t}`}>{s}</span>

/** prototype lcSteps() */
function Steps({ steps }: { steps: { l: string; s: '' | 'done' | 'cur' | 'bad'; d?: string }[] }) {
  return <div className="lc8">{steps.map((s, i) => <div key={s.l} className={`lc8-s ${s.s}`}>
    <div className="lc8-d">{s.s === 'done' ? <Ic n="check" size={13} /> : s.s === 'bad' ? <Ic n="x" size={13} /> : i + 1}</div>
    <div className="lc8-t"><b>{s.l}</b>{s.d && <small>{s.d}</small>}</div></div>)}</div>
}

export default function ProductRecordPage() {
  const { id: idParam } = useParams()
  const id = Number(idParam)
  const navigate = useNavigate()
  const [sp, setSp] = useSearchParams()
  const { success, error, warning } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [d, setD] = useState<Detail | null>(null)
  const [missing, setMissing] = useState('')
  const [modal, setModal] = useState<null | 'edit' | 'window' | { to: string; kind: 'next' | 'final' | 'return' }>(null)
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('t') || '') ? sp.get('t') as Tab : 'Overview'
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); if (t === 'Overview') n.delete('t'); else n.set('t', t); return n }, { replace: true })
  const load = useCallback(() => productApi.get(id).then(x => { setD(x); setMissing('') }).catch(e => { setMissing(errMsg(e, 'Could not load the product')) }), [id])
  useEffect(() => { productApi.meta().then(setMeta).catch(e => error(errMsg(e, 'Could not load Product & Price Books'))) }, [error])
  useEffect(() => { if (Number.isFinite(id)) void load(); else setMissing('Product not found') }, [id, load])

  if (missing) return <div className="bwi ppage"><div className="crumb"><a onClick={() => navigate('/products')}>Products</a></div><div className="empty">{missing}</div></div>
  if (!d || !meta) return <div className="bwi ppage"><div className="empty">Loading…</div></div>
  const m = meta.model, can = d.can
  const si = m.statuses.findIndex(s => s.name === d.status), n = m.statuses.length
  const editable = !d.pending_status && (!d.locked || !m.rules.lockEdits || d.window?.status === 'open')
  const mg = d.margin, prim = d.mappings.filter(x => x.role === 'Primary').length, usedIn = new Set(d.mappings.map(x => x.category_id)).size
  const last = d.log[0]
  const Tile = (l: string, v: ReactNode, s?: ReactNode, cl = '') => <div className="rht"><label>{l}</label><b className={cl}>{v}</b>{s ? <small>{s}</small> : null}</div>
  const done = (msg: string) => { setModal(null); if (msg) success(msg); void load() }
  const count = (t: Tab) => t === 'Specifications' ? d.specs.length : t === 'Category mapping' ? d.mappings.length : t === 'Change log' ? d.log.length : null

  return <div className="bwi ppage">
    <div className="crumb"><a onClick={() => navigate('/products')}>Products</a> / {d.code}</div>
    <div className="pg">
      <div><h1>{d.name}</h1>
        <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>{d.status ? <Pill s={d.status} t={stTone(m, d.status)} /> : null}{d.cat && <span className="pill ac">{d.cat}</span>}
          <span className="mu">{d.code} · {m.name}{meta.companies.length > 1 ? ` · ${d.company}` : ''}</span>
          {d.pending_status && <Pill s={`Waiting for approval → ${d.pending_status}`} t="wa" />}</div></div>
      <span className="fl" />
      {can.update && <button type="button" className="btn" disabled={!!d.pending_status || d.window?.status === 'pending'} onClick={() => setModal('edit')}><Ic n="edit" /> Edit details</button>}
      {can.update && d.actions.return && <button type="button" className="btn" onClick={() => setModal({ to: d.actions.return!, kind: 'return' })}>Return to {d.actions.return}</button>}
      {can.update && d.actions.next && <button type="button" className="btn p" onClick={() => setModal({ to: d.actions.next!, kind: 'next' })}>{d.actions.next_label || `Move to ${d.actions.next}`} <Ic n="right" /></button>}
      {can.update && d.actions.final && <button type="button" className="btn d" onClick={() => setModal({ to: d.actions.final!, kind: 'final' })}>Mark {d.actions.final.toLowerCase()}</button>}
    </div>
    <div className="rhero">
      <div className="rhg">
        {Tile('List price', d.list != null ? inr(d.list) : '—', `per ${d.unit || 'unit'}`)}
        {Tile('Standard cost', d.cost != null ? inr(d.cost) : '—')}
        {Tile('Margin', `${mg}%`, d.floor != null ? `floor ${inr(d.floor)}` : '', mg < m.rules.minMargin ? 'tbad' : 'tok')}
        {Tile('Used in', `${usedIn} categor${usedIn === 1 ? 'y' : 'ies'}`, `${prim} primary`)}
        {Tile('Specifications', `${d.specs.length} rows`)}
        {Tile('Last change', last ? fd(last.date) : fd(d.updated_at), last ? last.field : '')}
      </div>
      <div style={{ padding: '10px 14px 4px' }}><Steps steps={m.statuses.map((s, i) => ({ l: s.name, s: i < si ? 'done' : i === si ? (i === n - 1 ? 'bad' : 'cur') : '', d: i === si ? 'current' : d.pending_status === s.name ? 'awaiting approval' : undefined }))} /></div>
      {d.locked && <div className="rhsig"><span className="sg wa"><Ic n="lock" /> {d.status} record – every change needs a reason and an approver, and is written to the change log</span>
        {d.window?.status === 'open' && <span className="sg ok">Change window open · “{d.window.reason}” · approver {d.window.approver}
          {can.update && <a role="button" className="sgx" onClick={async () => { try { await productApi.closeWindow(d.id); done('Change window closed') } catch (e) { error(errMsg(e, 'Could not close the window')) } }}>Close</a>}</span>}
        {d.window?.status === 'pending' && <span className="sg wa">Change window “{d.window.reason}” is waiting for approval</span>}</div>}
    </div>
    <div className="tabs mb pxtabs" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}{count(t) != null && <> <small>{count(t)}</small></>}</div>)}</div>
    {tab === 'Overview' && <Overview d={d} meta={meta} />}
    {tab === 'Specifications' && <Specs d={d} meta={meta} editable={editable && can.update} onUnlock={() => setModal('window')} onSaved={() => { success('Specifications saved'); void load() }} />}
    {tab === 'Category mapping' && <Mappings d={d} meta={meta} editable={editable && can.update} onUnlock={() => setModal('window')} onSaved={() => { success('Category mapping saved'); void load() }} />}
    {tab === 'Pricing' && <Pricing d={d} meta={meta} editable={editable && can.update} onUnlock={() => setModal('window')} onSaved={msg => { success(msg); void load() }} />}
    {tab === 'Lifecycle' && <Lifecycle d={d} meta={meta} />}
    {tab === 'Change log' && <LogTab d={d} />}
    {tab === 'Brochure' && <Brochure d={d} meta={meta} />}
    {modal === 'edit' && <EditProductModal meta={meta} d={d} onClose={() => setModal(null)} onSaved={done} />}
    {modal === 'window' && <WindowModal d={d} onClose={() => setModal(null)} onDone={msg => { setModal(null); (msg.includes('approval') ? warning : success)(msg); void load() }} />}
    {modal && typeof modal === 'object' && <StatusModal meta={meta} d={d} to={modal.to} kind={modal.kind} onClose={() => setModal(null)} onDone={msg => { setModal(null); (msg.startsWith('Sent') ? warning : success)(msg); void load() }} />}
  </div>
}

/** prototype pxUnlockBar() */
function UnlockBar({ d, meta, onUnlock }: { d: Detail; meta: Meta; onUnlock: () => void }) {
  if (d.pending_status) return <div className="note mb row"><Ic n="clock" /><span className="fl">Waiting for approval to move to <b>{d.pending_status}</b> – the record can’t be edited until it is decided.</span></div>
  if (!d.locked || !meta.model.rules.lockEdits || d.window?.status === 'open') return null
  if (d.window?.status === 'pending') return <div className="note mb row"><Ic n="lock" /><span className="fl">The change window “{d.window.reason}” is waiting for approval in Approvals.</span></div>
  return <div className="note mb row"><Ic n="lock" /><span className="fl">This record is <b>{d.status}</b>. Open a change window to edit – you’ll give a reason, it is approved through Approvals, and every edit is logged.</span>
    {d.can.update && <button type="button" className="btn s p" onClick={onUnlock}>Open change window</button>}</div>
}

/* ── Overview (prototype pxOverview: grouped field cards) ── */
function fieldView(d: Detail, f: MField, meta: Meta) {
  const v = f.key === 'oem' ? d.oem : d.fields[f.key]
  const empty = v == null || v === ''
  const miss = f.req && empty
  let h: ReactNode
  if (empty) h = <span className={miss ? 'tbad' : 'mu'}>{miss ? 'Required – not filled' : '—'}</span>
  else if (f.key === 'features') h = <ul className="px8-ul">{String(v).split(/;\s*/).filter(Boolean).map((x, i) => <li key={i}>{x}</li>)}</ul>
  else if (f.type === 'cur') h = <b>{inr(Number(v))}</b>
  else if (f.key === 'status') h = <Pill s={String(v)} t={stTone(meta.model, String(v))} />
  else if (f.type === 'date') h = fd(String(v))
  else h = String(v)
  return <div key={f.key} className={`px8-f ${f.type === 'ta' ? 'w2' : ''}`}><label>{f.label}{f.req && <> <b className="tbad">*</b></>}</label><div>{h}</div>{f.help && <small>{f.help}</small>}</div>
}
function Overview({ d, meta }: { d: Detail; meta: Meta }) {
  const on = meta.model.fields.filter(f => f.on)
  const filled = (fs: MField[]) => fs.filter(f => { const v = f.key === 'oem' ? d.oem : d.fields[f.key]; return v != null && v !== '' }).length
  const G: [string, MField[]][] = [
    ['Identity', on.filter(f => ['code', 'name', 'cat', 'coo', 'status', 'unit'].includes(f.key))],
    ['Description', on.filter(f => ['longDesc', 'features'].includes(f.key))],
    ['Usage', on.filter(f => ['policy', 'guide'].includes(f.key))],
    ['Supply requirements', on.filter(f => f.key === 'supply')],
    [`${meta.model.name} fields`, on.filter(f => f.source === 'x' || f.source === 'custom')],
    ['Commercial', on.filter(f => f.source === 'com' && f.key !== 'unit')],
  ]
  const cats = [...new Set(d.mappings.map(x => x.cat))]
  return <div className="dcs">
    {G.filter(g => g[1].length).map(([t, fs]) => <div key={t} className="dc"><div className="dch">{t}<span className="fl" /><small className="mu">{filled(fs)}/{fs.length} filled</small></div>
      <div className="px8-fg">{fs.map(f => fieldView(d, f, meta))}</div></div>)}
    <div className="dc"><div className="dch">Pricing &amp; category usage<span className="fl" /><small className="mu">{d.pricing.length} price books</small></div>
      <div className="px8-fg">
        <div className="px8-f"><label>Margin</label><div><b className={d.margin < meta.model.rules.minMargin ? 'tbad' : 'tok'}>{d.margin}%</b></div><small>Minimum margin {meta.model.rules.minMargin}% · floor {d.floor != null ? inr(d.floor) : '—'}</small></div>
        <div className="px8-f"><label>Lifecycle status</label><div>{d.status}{d.locked ? ' · locked' : ''}</div></div>
        <div className="px8-f w2"><label>Used in categories</label><div>{cats.length ? cats.join(', ') : <span className="mu">Not mapped yet</span>}</div></div>
      </div></div>
  </div>
}

/* ── Specifications (five-column template structure) ── */
function Specs({ d, meta, editable, onUnlock, onSaved }: { d: Detail; meta: Meta; editable: boolean; onUnlock: () => void; onSaved: () => void }) {
  const { error, success } = useToast()
  const [rows, setRows] = useState<Spec[]>(d.specs)
  const [busy, setBusy] = useState(false)
  useEffect(() => setRows(d.specs), [d.specs])
  const dirty = JSON.stringify(rows) !== JSON.stringify(d.specs)
  const set = (i: number, k: keyof Spec, v: string) => setRows(r => r.map((x, j) => j === i ? { ...x, [k]: v } : x))
  const move = (i: number, by: number) => setRows(r => { const n = [...r]; const j = i + by; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j], n[i]]; return n })
  const addTpl = () => {
    const have = new Set(rows.map(x => x.p.toLowerCase()))
    const add = meta.model.specs.filter(s => s[0] && !have.has(s[0].toLowerCase())).map(s => ({ p: s[0], v: s[1] || '', u: s[2] || '', std: s[3] || '', rm: s[4] || '' }))
    if (!add.length) { success('All template parameters are already present'); return }
    setRows(r => [...r, ...add])
  }
  const save = async () => {
    const bad = rows.findIndex(r => !r.p.trim() || !r.v.trim())
    if (bad >= 0) { error(`Row ${bad + 1}: parameter and value / range are required`); return }
    setBusy(true)
    try { await productApi.specs(d.id, rows); onSaved() } catch (e) { error(errMsg(e, 'Could not save the specifications')) } finally { setBusy(false) }
  }
  return <><UnlockBar d={d} meta={meta} onUnlock={onUnlock} />
    <div className="panel"><div className="ph">Specifications<span className="fl" /><small className="mu">Five-column structure from the template</small>
      {editable && <><button type="button" className="btn s" onClick={addTpl}>Add template parameters</button>
        <button type="button" className="btn s p" onClick={() => setRows(r => [...r, { p: '', v: '', u: '', std: '', rm: '' }])}><Ic n="plus" /> Add row</button></>}</div>
      <div className="pb z"><div className="tw fit"><table className="t"><thead><tr><th>Parameter</th><th>Value / range</th><th>Unit</th><th>Standard / material</th><th>Remarks / options</th>{editable && <th />}</tr></thead>
        <tbody>{rows.map((s, i) => editable ? <tr key={s.id ?? `n${i}`}>{(['p', 'v', 'u', 'std', 'rm'] as (keyof Spec)[]).map(k => <td key={k}>
          <input className={`in sm ${(k === 'p' || k === 'v') && !String(s[k] || '').trim() ? 'err' : ''}`} value={String(s[k] ?? '')} maxLength={k === 'u' ? 60 : k === 'rm' ? 500 : 300}
            aria-label={`Row ${i + 1} ${k}`} placeholder={k === 'p' ? 'Parameter *' : k === 'v' ? 'Value *' : ''} onChange={e => set(i, k, e.target.value)} /></td>)}
          <td className="nowrap"><button type="button" className="btn g s" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="btn g s" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="btn g s" aria-label="Remove row" onClick={() => setRows(r => r.filter((_, j) => j !== i))}><Ic n="x" /></button></td></tr>
          : <tr key={s.id ?? i}><td><b>{s.p}</b></td><td>{s.v}</td><td>{s.u}</td><td>{s.std}</td><td className="mu">{s.rm}</td></tr>)}
          {!rows.length && <tr><td colSpan={6}><div className="empty">No specification rows yet</div></td></tr>}</tbody></table></div></div>
      {editable && dirty && <div className="pf row"><span className="fl mu">Unsaved changes{d.locked ? ' – each change is logged with the change window reason' : ''}</span>
        <button type="button" className="btn" onClick={() => setRows(d.specs)}>Discard</button><button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save specifications'}</button></div>}
    </div></>
}

/* ── Category mapping ── */
function Mappings({ d, meta, editable, onUnlock, onSaved }: { d: Detail; meta: Meta; editable: boolean; onUnlock: () => void; onSaved: () => void }) {
  const { error } = useToast()
  const m = meta.model
  const [rows, setRows] = useState<Mapping[]>(d.mappings)
  const [busy, setBusy] = useState(false)
  useEffect(() => setRows(d.mappings), [d.mappings])
  const dirty = JSON.stringify(rows.map(r => [r.category_id, r.stage_id, r.role, r.rm])) !== JSON.stringify(d.mappings.map(r => [r.category_id, r.stage_id, r.role, r.rm]))
  const prim = rows.filter(x => x.role === 'Primary').length
  const internal = m.categories.filter(c => c.internal).map(c => c.name)
  const dup = (() => { const s = new Set<string>(); for (const r of rows) { const k = `${r.category_id}:${r.stage_id}`; if (s.has(k)) return true; s.add(k) } return false })()
  const set = (i: number, k: keyof Mapping, v: string) => setRows(r => r.map((x, j) => j === i ? { ...x, [k]: (k === 'category_id' || k === 'stage_id') ? (v ? Number(v) : '') : v } : x))
  const add = () => {
    const used = new Set(rows.map(x => x.category_id))
    const cat = m.categories.find(c => !used.has(c.id!)) || m.categories[0]
    setRows(r => [...r, { category_id: cat?.id ?? '', stage_id: m.stages[0]?.id ?? '', role: r.some(x => x.role === 'Primary') ? (m.roles.find(x => x !== 'Primary') || 'Supporting') : 'Primary', rm: '' }])
  }
  const save = async () => {
    if (rows.some(r => r.category_id === '' || r.stage_id === '')) { error(`Choose a category and a ${m.grouping.toLowerCase()} on every row`); return }
    if (dup) { error(`Each category and ${m.grouping.toLowerCase()} can be mapped once`); return }
    setBusy(true)
    try { await productApi.mappings(d.id, rows); onSaved() } catch (e) { error(errMsg(e, 'Could not save the mapping')) } finally { setBusy(false) }
  }
  return <><UnlockBar d={d} meta={meta} onUnlock={onUnlock} />
    <div className="note inf mb">One row per category where the product is used, with its {m.grouping.toLowerCase()} and role. These rows drive the category pages of the brochure{internal.length ? ` – ${internal.join(', ')} is internal and never shown to customers` : ''}.</div>
    {prim !== 1 && <div className="note mb"><Ic n="alert" /> Each product needs exactly one <b>Primary</b> mapping – this one has {prim}.</div>}
    {dup && <div className="note mb"><Ic n="alert" /> The same category and {m.grouping.toLowerCase()} is mapped twice.</div>}
    <div className="panel"><div className="ph">Category mapping<span className="fl" />{editable && <button type="button" className="btn s p" onClick={add}><Ic n="plus" /> Add category</button>}</div>
      <div className="pb z"><div className="tw fit"><table className="t"><thead><tr><th>Category</th><th>{m.grouping}</th><th>Role</th><th>Remarks</th>{editable && <th />}</tr></thead>
        <tbody>{rows.map((x, i) => editable ? <tr key={x.id ?? `n${i}`}>
          <td><select className="in sm" value={x.category_id} aria-label={`Row ${i + 1} category`} onChange={e => set(i, 'category_id', e.target.value)}>{m.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></td>
          <td><select className="in sm" value={x.stage_id} aria-label={`Row ${i + 1} ${m.grouping}`} onChange={e => set(i, 'stage_id', e.target.value)}>{m.stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
          <td><select className="in sm" value={x.role} aria-label={`Row ${i + 1} role`} onChange={e => set(i, 'role', e.target.value)}>{m.roles.map(r => <option key={r}>{r}</option>)}</select></td>
          <td><input className="in sm" value={x.rm} maxLength={500} aria-label={`Row ${i + 1} remarks`} onChange={e => set(i, 'rm', e.target.value)} /></td>
          <td><button type="button" className="btn g s" aria-label="Remove mapping" onClick={() => setRows(r => r.filter((_, j) => j !== i))}><Ic n="x" /></button></td></tr>
          : <tr key={x.id ?? i}><td><b>{x.cat}</b>{x.internal && <> <span className="pill mu">internal</span></>}</td><td>{x.stage}</td><td><Pill s={x.role} t={x.role === 'Primary' ? 'ac' : 'mu'} /></td><td className="mu">{x.rm}</td></tr>)}
          {!rows.length && <tr><td colSpan={5}><div className="empty">Not mapped to any category yet</div></td></tr>}</tbody></table></div></div>
      {editable && dirty && <div className="pf row"><span className="fl mu">Unsaved changes</span>
        <button type="button" className="btn" onClick={() => setRows(d.mappings)}>Discard</button><button type="button" className="btn p" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save mapping'}</button></div>}
    </div></>
}

/* ── Pricing ── */
function Pricing({ d, meta, editable, onUnlock, onSaved }: { d: Detail; meta: Meta; editable: boolean; onUnlock: () => void; onSaved: (msg: string) => void }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const r = meta.model.rules
  const [v, setV] = useState({ list: d.list != null ? String(d.list) : '', cost: d.cost != null ? String(d.cost) : '', unit: d.unit })
  useEffect(() => setV({ list: d.list != null ? String(d.list) : '', cost: d.cost != null ? String(d.cost) : '', unit: d.unit }), [d.list, d.cost, d.unit])
  const put = async (k: 'list' | 'cost' | 'unit', val: string) => {
    const orig = k === 'unit' ? d.unit : (d[k] != null ? String(d[k]) : '')
    if (val === orig) return
    if (k !== 'unit' && val !== '' && (Number.isNaN(Number(val)) || Number(val) < 0)) { error(`${k === 'list' ? 'List price' : 'Standard cost'} must be zero or more`); setV(s => ({ ...s, [k]: orig })); return }
    try { await productApi.update(d.id, { [k]: val }); onSaved(`${k === 'list' ? 'List price' : k === 'cost' ? 'Standard cost' : 'Unit'} updated${d.locked ? ' and logged' : ''}`) }
    catch (e) { error(errMsg(e, 'Could not save')); setV(s => ({ ...s, [k]: orig })) }
  }
  const mgNow = Number(v.list) ? Math.round((1 - Number(v.cost || 0) / Number(v.list)) * 100) : 0
  return <><UnlockBar d={d} meta={meta} onUnlock={onUnlock} />
    <div className="g g2">
      <div className="panel"><div className="ph">List price &amp; cost</div><div className="pb"><div className="fg">
        <div><label htmlFor="pp-l">List price (₹)</label><input id="pp-l" className="in" type="number" min={0} step="any" disabled={!editable} value={v.list} onChange={e => setV(s => ({ ...s, list: e.target.value }))} onBlur={() => put('list', v.list)} /></div>
        <div><label htmlFor="pp-c">Standard cost (₹)</label><input id="pp-c" className="in" type="number" min={0} step="any" disabled={!editable} value={v.cost} onChange={e => setV(s => ({ ...s, cost: e.target.value }))} onBlur={() => put('cost', v.cost)} /></div>
        <div><label htmlFor="pp-u">Unit</label><select id="pp-u" className="in" disabled={!editable} value={v.unit} onChange={e => { setV(s => ({ ...s, unit: e.target.value })); void put('unit', e.target.value) }}>
          <option value="">—</option>{meta.model.units.map(u => <option key={u}>{u}</option>)}</select></div>
        <div><label>Margin</label><input className="in" disabled value={`${mgNow}% · floor ${v.cost !== '' ? inr(Math.round(Number(v.cost) * (1 + r.minMargin / 100))) : '—'}`} /></div>
      </div><div className="note inf mt">Book prices below the floor (cost + {r.minMargin}% minimum margin) or discounts beyond {r.discLimit}% need Sales Head approval.</div></div></div>
      <div className="panel"><div className="ph">Where it is quoted<span className="fl" /><small className="mu">{d.quotes.length} quotes</small></div><div className="pb z">
        {!d.quotes.length ? <div className="empty">Not used in a quote yet</div> : <table className="t"><thead><tr><th>Quote</th><th>Customer</th><th>Stage</th></tr></thead><tbody>
          {d.quotes.slice(0, 6).map(q => <tr key={q.id}><td><a onClick={() => navigate(`/quotations/${q.id}`)}>{q.number}{q.rev ? ` · Rev ${q.rev}` : ''}</a></td><td>{q.customer || '—'}</td><td>{q.status ? <Pill s={q.status} t="inf" /> : '—'}</td></tr>)}</tbody></table>}
      </div></div>
    </div>
    <div className="panel mt"><div className="ph">Price books</div><div className="pb z">
      {!d.pricing.length ? <div className="empty">{d.status === meta.model.final ? `${meta.model.final} products are not offered in price books` : 'No price books yet'}</div> :
        <table className="t"><thead><tr><th>Price book</th><th>Rule</th><th className="r">Book price</th><th className="r">Margin</th><th>Status</th></tr></thead><tbody>
          {d.pricing.map(b => <tr key={b.id}><td><b>{b.name}</b><br /><small className="mu">{b.applies_to}</small></td><td>{b.adjustment > 0 ? '+' : ''}{b.adjustment}% on list</td>
            <td className="r"><b>{money(b.price, b.currency)}</b>{b.override && <> <span className="pill wa">override</span></>}</td>
            <td className="r">{b.margin == null ? '—' : <span className={b.margin < r.minMargin ? 'tbad' : 'tok'}>{b.margin}%</span>}</td>
            <td><Pill s={b.status} t={b.status === 'Active' ? 'ok' : b.status === 'Expired' ? 'ba' : 'mu'} /></td></tr>)}</tbody></table>}
    </div></div></>
}

/* ── Lifecycle ── */
function Lifecycle({ d, meta }: { d: Detail; meta: Meta }) {
  const m = meta.model
  const si = m.statuses.findIndex(s => s.name === d.status)
  const hist = d.log.filter(l => l.field === 'Record Status')
  return <><div className="panel mb"><div className="ph">Delivery lifecycle · {m.name}<span className="fl" /><small className="mu">Set under Configuration → Product delivery lifecycle</small></div>
    <div className="pb"><div className="px8-life">{m.life.map((s, i) => <div key={s}><span>{i + 1}</span><b>{s}</b></div>)}</div></div></div>
    <div className="g g2">
      <div className="panel"><div className="ph">Record status</div><div className="pb"><Steps steps={m.statuses.map((s, i) => ({ l: s.name, s: i < si ? 'done' : i === si ? 'cur' : '', d: s.lock ? 'approved · locked' : undefined }))} />
        {d.pending_status && <div className="note mt">Waiting for approval to move to <b>{d.pending_status}</b>.</div>}</div></div>
      <div className="panel"><div className="ph">Status history</div><div className="pb">
        {!hist.length ? <div className="empty">No events yet</div> : <div className="tl8">{hist.map(l => <div key={l.id}><span className="tl8-d">{fd(l.date)}</span>
          <i className={`tl8-i ${l.approval === 'Rejected' ? 'ba' : l.approval === 'Pending' ? 'wa' : 'ac'}`} />
          <div className="tl8-b"><span><b>{l.old || '—'} → {l.new}</b></span><small>{l.by || 'System'}{l.reason ? ` · ${l.reason}` : ''}{l.approver ? ` · approved by ${l.approver}` : ''}</small></div></div>)}</div>}
      </div></div>
    </div></>
}

/* ── Change log ── */
function LogTab({ d }: { d: Detail }) {
  return <div className="panel"><div className="pb z"><div className="tw fit">{!d.log.length ? <div className="empty">No changes recorded yet</div> :
    <table className="t"><thead><tr><th>Date</th><th>Sheet / field</th><th>Previous value</th><th>New value</th><th>Reason for change</th><th>Changed by</th><th>Approved by</th></tr></thead>
      <tbody>{d.log.map(l => <tr key={l.id}><td className="nowrap">{fdt(l.date)}</td><td>{l.field}</td><td><span className="mu">{l.old || '—'}</span></td><td><b>{l.new || '—'}</b></td>
        <td>{l.reason || <span className="mu">—</span>}</td><td>{l.by || <span className="mu">System</span>}</td>
        <td>{l.approver ? l.approver : l.approval === 'Pending' ? <Pill s="Pending" t="wa" /> : <span className="mu">—</span>}</td></tr>)}</tbody></table>}</div></div></div>
}

/* ── Brochure (prototype pxBrochure: data sheet from the record and its category mapping) ── */
function Brochure({ d, meta }: { d: Detail; meta: Meta }) {
  const m = meta.model
  const cats = useMemo(() => d.mappings.filter(x => !(m.rules.hideInternal && x.internal)), [d.mappings, m.rules.hideInternal])
  const print = () => {
    const h = document.getElementById('pxsheet')
    if (!h) return
    const w = window.open('', '_blank')
    if (!w) return
    const esc = (x: string) => x.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] as string))
    w.document.write(`<html><head><title>${esc(d.code)}</title><style>body{font:13px/1.5 system-ui,sans-serif;padding:28px;color:#111}h2{margin:2px 0}h4{margin:16px 0 4px;color:#0F6E8C}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:5px 8px;text-align:left}.px8-sh{display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid #0F6E8C;padding-bottom:12px}.px8-cats span{display:inline-block;border:1px solid #0F6E8C;color:#0F6E8C;border-radius:10px;padding:1px 8px;margin:2px;font-size:11px}.px8-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}.px8-fine{font-size:11px;color:#555}</style></head><body>${h.innerHTML}</body></html>`)
    w.document.close(); w.focus(); w.print()
  }
  return <><div className="row mb"><span className="mu">{d.status === m.lock ? `Ready to share – this record is ${m.lock.toLowerCase()}.` : `Preview only – brochures are published from ${m.lock.toLowerCase()} records.`}</span><span className="fl" />
    <button type="button" className="btn" onClick={print}><Ic n="doc" /> Print data sheet</button></div>
    <div className="px8-sheet" id="pxsheet">
      <div className="px8-sh"><div><small>{d.company}</small><h2>{d.name}</h2><span>{d.code}</span></div><div className="px8-cats">{[...new Set(cats.map(x => x.cat))].map(c => <span key={c}>{c}</span>)}</div></div>
      {d.longDesc && <p className="px8-lead">{d.longDesc}</p>}
      {d.features && <><h4>Features &amp; benefits</h4><ul>{d.features.split(/;\s*/).filter(Boolean).map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      {d.specs.length > 0 && <><h4>Specifications</h4><table><tbody>{d.specs.map((s, i) => <tr key={i}><th>{s.p}</th><td>{s.v} {s.u && s.u !== '—' && s.u !== 'Not applicable' ? s.u : ''}</td><td>{s.std}</td></tr>)}</tbody></table></>}
      <div className="px8-2">{d.guide && <div><h4>Usage guidelines</h4><p>{d.guide}</p></div>}{d.supply && <div><h4>Supply requirements</h4><p>{d.supply}</p></div>}</div>
      {d.policy && <p className="px8-fine"><b>Usage policy.</b> {d.policy}</p>}
      <p className="px8-fine">Country of origin: {d.coo || '—'} · {m.grouping}s: {[...new Set(cats.map(x => x.stage))].join(', ') || '—'}</p>
    </div></>
}
