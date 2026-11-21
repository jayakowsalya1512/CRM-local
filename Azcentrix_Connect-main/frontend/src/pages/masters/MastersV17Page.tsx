// Masters – prototype v17 R.masters (line ~1893): crumb Directory · "Masters" · "N masters · M custom" · + New master; info note;
// .split: left panel "Masters" with search + list (name, custom pill, count; child masters indented under their parent),
// right: "<name> <Standard|Custom · kind>" with Add value · Import · Export · Add to a form · (Rename · Delete master for custom),
// description, value table (# · Value · attribute columns · Parent · Used · Active · ↑ ↓ ✕) and "Where this master is used".
// Standard masters keep their own tables; parent › child links work for both (e.g. Customer segments › Customer sub segments).
// Locations, Groups and Questionnaire are not value lists – they open their existing screens inside the right column.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Panel } from '@/pages/customers/kit'
import { useModuleName } from '@/context/ModuleLabelsContext'
import GroupFixingPage from './GroupFixingPage'
import LocationHierarchyPage from './LocationHierarchyPage'
import QuestionnaireMasterPage from './QuestionnaireMasterPage'
import { errMsg, mastersApi, type MasterItem, type MasterPage, type Tree } from './mastersApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './masters.css'

const Sw = ({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) => (
  <label className="sw"><input type="checkbox" checked={on} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.checked)} /><i /></label>
)
type ModalState =
  | { t: 'new' } | { t: 'ren' } | { t: 'addv' } | { t: 'imp' } | { t: 'form' }
  | { t: 'confirm'; title: string; body: ReactNode; ok: string; danger?: boolean; fn: () => Promise<void> }
const PAGE = 50

/** left list order: standard masters first in registry order, each parent followed by its children, then custom masters */
function ordered(ms: MasterItem[]): (MasterItem & { child: boolean })[] {
  const out: (MasterItem & { child: boolean })[] = []
  const kids = (k: string) => ms.filter(m => m.parent_key === k)
  const seen = new Set<string>()
  const push = (m: MasterItem, child: boolean) => { if (seen.has(m.key)) return; seen.add(m.key); out.push({ ...m, child }); kids(m.key).forEach(c => push(c, true)) }
  ms.filter(m => !m.parent_key || !ms.some(x => x.key === m.parent_key)).forEach(m => push(m, false))
  ms.forEach(m => push(m, !!m.parent_key))
  return out
}

export default function MastersV17Page() {
  const navigate = useNavigate()
  const { label: title } = useModuleName('masters')
  const { success, error, info } = useToast()
  const [sp, setSp] = useSearchParams()
  const [tree, setTree] = useState<Tree | null>(null)
  const [mq, setMq] = useState('')
  const [page, setPage] = useState<MasterPage | null>(null)
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [busy, setBusy] = useState(false)
  const sel = sp.get('m') || ''
  const setSel = (k: string) => { setSp(s => { const n = new URLSearchParams(s); n.set('m', k); return n }); setQ(''); setOffset(0) }

  const loadTree = useCallback(() => mastersApi.tree().then(setTree).catch(e => error(errMsg(e, 'Could not load Masters'))), [error])
  useEffect(() => { loadTree() }, [loadTree])
  const list = useMemo(() => tree ? ordered(tree.masters) : [], [tree])
  const cur = sel || list[0]?.key || ''
  const isScreen = !!tree?.screens.some(s => s.key === cur)
  const loadPage = useCallback(() => {
    if (!cur || isScreen) { setPage(null); return }
    mastersApi.master(cur, { q, offset, limit: PAGE }).then(setPage).catch(e => error(errMsg(e, 'Could not load the master')))
  }, [cur, isScreen, q, offset, error])
  useEffect(() => { const t = setTimeout(loadPage, q ? 150 : 0); return () => clearTimeout(t) }, [loadPage, q])
  const refresh = () => { loadPage(); loadTree() }
  const act = async (msg: string, fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return
    setBusy(true)
    try { await fn(); refresh(); if (msg) success(msg); after?.() } catch (e) { error(errMsg(e)) } finally { setBusy(false) }
  }
  if (!tree) return <div className="bwi"><div className="empty">Loading…</div></div>
  const can = tree.can_manage
  const def = page?.def
  const parentDef = def?.parent_key ? tree.masters.find(m => m.key === def.parent_key) : null
  const names = list.filter(m => !mq || m.name.toLowerCase().includes(mq.toLowerCase()))
  const attrs = def?.attrs || []

  const exportCsv = async () => {
    if (!def) return
    try {
      const all = await mastersApi.master(def.key, { limit: 500, offset: 0 })
      const head = ['Value', ...attrs, ...(def.parent_key ? ['Parent'] : []), 'Active']
      const rows = all.items.map(v => [v.v, ...attrs.map(a => v.attrs[a] || ''), ...(def.parent_key ? [v.parent] : []), v.on ? 'Yes' : 'No'])
      const csv = [head, ...rows].map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n')
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${def.name}.csv`; a.click(); URL.revokeObjectURL(a.href)
      success(`${def.name} exported`)
    } catch (e) { error(errMsg(e)) }
  }

  return <div className="bwi">
    <div className="pg"><div><div className="crumb">Directory</div><h1>{title || 'Masters'}</h1></div>
      <span className="cnt">{tree.masters.length} masters · {tree.custom} custom</span><span className="fl" />
      <button type="button" className="btn p" disabled={!can} onClick={() => setModal({ t: 'new' })}><Ic n="plus" /> New master</button></div>
    <div className="note inf mb">A <b>master</b> is a controlled list (industries, regions, contract types…). Create your own, then add it to any form with <b>Customization Studio → Add field → Master lookup</b> – or use “Add to a form” below.
      A <b>hierarchy</b> master is linked to a parent master, so every value picks its parent value (for example Customer segments › Customer sub segments).</div>
    <div className="split">
      <div className="panel mside"><div className="ph">Masters<span className="fl" /></div>
        <div className="pb" style={{ padding: 6 }}><input className="in sm" placeholder="Search masters…" value={mq} onChange={e => setMq(e.target.value)} aria-label="Search masters" /></div>
        <div className="side">
          {names.map(m => <div key={m.key} role="button" tabIndex={0} className={`${m.key === cur ? 'on' : ''} ${m.child ? 'child' : ''}`} onClick={() => setSel(m.key)} onKeyDown={e => { if (e.key === 'Enter') setSel(m.key) }}>
            <span className="fl">{m.name}{!m.std && <span className="pill ac">custom</span>}</span><small>{m.n}</small></div>)}
          {!mq && <><h6>Screens</h6>{tree.screens.map(s => <div key={s.key} role="button" tabIndex={0} className={s.key === cur ? 'on' : ''} onClick={() => setSel(s.key)} onKeyDown={e => { if (e.key === 'Enter') setSel(s.key) }}>
            <span className="fl">{s.name}</span><small>›</small></div>)}</>}
        </div></div>
      <div>
        {isScreen ? <div className={`embed ${cur === 'locations' ? 'tall' : ''}`}>
          {cur === 'locations' ? <LocationHierarchyPage embedded /> : cur === 'group-fixing' ? <GroupFixingPage embedded /> : <QuestionnaireMasterPage embedded />}
        </div> : !page || !def ? <div className="panel"><div className="empty">Loading…</div></div> : <>
          <Panel z title={<>{def.name} <span className={`pill ${def.std ? 'mu' : 'ac'}`}>{def.std ? 'Standard' : 'Custom'} · {def.kind}</span>{parentDef && <small className="mu"> under {parentDef.name}</small>}</>}>
            <div className="mtb">
              <button type="button" className="btn p s" disabled={!can} onClick={() => setModal({ t: 'addv' })}><Ic n="plus" /> Add value</button>
              <button type="button" className="btn s" disabled={!can} onClick={() => setModal({ t: 'imp' })}><Ic n="up" /> Import</button>
              <button type="button" className="btn s" onClick={exportCsv}><Ic n="dl" /> Export</button>
              <button type="button" className="btn s" disabled={!can} onClick={() => setModal({ t: 'form' })}><Ic n="layout" /> Add to a form</button>
              <span className="fl" />
              <div className="sr2" style={{ width: 220 }}><Ic n="search" /><input className="in sm" placeholder="Search values…" value={q} onChange={e => { setQ(e.target.value); setOffset(0) }} aria-label="Search values" /></div>
              {!def.std && can && <><button type="button" className="btn s" onClick={() => setModal({ t: 'ren' })}>Rename</button>
                <button type="button" className="btn s d" onClick={() => setModal({ t: 'confirm', title: 'Delete master', ok: 'Delete master', danger: true,
                  body: <>Delete master “{def.name}” and all its values? Forms using it must drop the lookup field first.</>,
                  fn: () => act('Master deleted', () => mastersApi.remove(def.key), () => { setModal(null); setSel(list[0]?.key || '') }) })}>Delete master</button></>}
            </div>
            <div className="mdesc"><small className="mu">{def.desc}</small></div>
            {page.items.length ? <div className="tw fit"><table className="t mv"><thead><tr><th>#</th><th>Value</th>{attrs.map(a => <th key={a}>{a}</th>)}{def.parent_key && <th>{parentDef?.name || 'Parent'}</th>}<th>Used</th><th className="c">Active</th><th /></tr></thead>
              <tbody>{page.items.map(r => <tr key={r.id} style={{ opacity: r.on ? 1 : .55 }}>
                <td>{r.pos + 1}</td>
                <td><input key={`${r.id}v${r.v}`} className="in sm" style={{ minWidth: 160 }} defaultValue={r.v} disabled={!can}
                  onBlur={e => { const v = e.target.value.trim(); if (!v) { e.target.value = r.v; return } if (v !== r.v) void act('Value saved', () => mastersApi.updateValue(def.key, r.id, { v })) }} /></td>
                {attrs.map(a => <td key={a}><input key={`${r.id}${a}${r.attrs[a]}`} className="in sm" style={{ minWidth: 110 }} defaultValue={r.attrs[a] || ''} disabled={!can}
                  onBlur={e => { const v = e.target.value.trim(); if (v !== (r.attrs[a] || '')) void act(`${a} saved`, () => mastersApi.updateValue(def.key, r.id, { attrs: { [a]: v } })) }} /></td>)}
                {def.parent_key && <td><select className="in sm" style={{ minWidth: 140 }} value={r.parent_id ?? ''} disabled={!can}
                  onChange={e => act('Parent saved', () => mastersApi.updateValue(def.key, r.id, { parent_id: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">—</option>{page.parents.map(p => <option key={p.id} value={p.id}>{p.v}</option>)}</select></td>}
                <td>{r.used ? <small>{r.used} records</small> : <small className="mu">—</small>}</td>
                <td className="c"><Sw on={r.on} disabled={!can} label={`${r.v} active`} onChange={v => act(v ? 'Value activated' : 'Value hidden from forms', () => mastersApi.updateValue(def.key, r.id, { on: v }))} /></td>
                <td className="nw">{can && <>{def.order && <><button type="button" className="btn g s" disabled={busy || !!q} title={q ? 'Clear the search to reorder' : 'Move up'} onClick={() => act('', () => mastersApi.move(def.key, r.id, -1))}>↑</button>
                  <button type="button" className="btn g s" disabled={busy || !!q} title={q ? 'Clear the search to reorder' : 'Move down'} onClick={() => act('', () => mastersApi.move(def.key, r.id, 1))}>↓</button></>}
                  <button type="button" className="btn g s" disabled={busy} title="Remove" onClick={() => setModal({ t: 'confirm', title: 'Remove value', ok: 'Remove', danger: true,
                    body: <>Remove “{r.v}” from {def.name}?{r.used ? ` It is used by ${r.used} records – switch it off instead.` : ''}</>,
                    fn: () => act('Value removed', () => mastersApi.deleteValue(def.key, r.id), () => setModal(null)) })}><Ic n="x" /></button></>}</td>
              </tr>)}</tbody></table></div> : <div className="empty">{q ? 'No value matches the search.' : 'No values yet – add the first value.'}</div>}
            {page.total > PAGE && <div className="pgn"><span>{offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total}</span><span className="fl" />
              <button type="button" className="btn s" disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - PAGE))}>‹ Prev</button>
              <button type="button" className="btn s" disabled={offset + PAGE >= page.total} onClick={() => setOffset(o => o + PAGE)}>Next ›</button></div>}
          </Panel>
          <Panel z className="mt" title="Where this master is used">
            {page.forms.length ? <div className="list">{page.forms.map((u, i) => <div key={i}><span className="fl"><b>{u.m}</b> · field “{u.f}”</span><a onClick={() => navigate('/form-builder')}>Open in builder</a></div>)}</div>
              : <div className="empty" style={{ padding: 14 }}>{def.use ? `Standard master used in: ${def.use}.` : 'Not used in any form yet.'} Use <b>Add to a form</b> to create a lookup field.</div>}
          </Panel>
        </>}
      </div>
    </div>

    {modal?.t === 'confirm' && <Modal title={modal.title} width={440} onClose={() => setModal(null)}
      foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button><button type="button" className={`btn ${modal.danger ? 'd' : 'p'}`} disabled={busy} onClick={() => modal.fn()}>{modal.ok}</button></>}>
      <p style={{ margin: 0 }}>{modal.body}</p></Modal>}
    {modal?.t === 'new' && <NewMasterModal tree={tree} onClose={() => setModal(null)}
      onCreate={d => act(`Master “${d.name}” created${d.add_to ? ' and added to the ' + (tree.modules.find(m => m.k === d.add_to)?.l || d.add_to) + ' form' : ''}`, () => mastersApi.create(d).then(r => setSel(r.key)), () => setModal(null))} />}
    {modal?.t === 'ren' && def && <RenameModal name={def.name} desc={def.desc} onClose={() => setModal(null)} onSave={(name, description) => act('Master renamed', () => mastersApi.rename(def.key, { name, description }), () => setModal(null))} />}
    {modal?.t === 'addv' && def && page && <AddValueModal def={def} parents={page.parents} parentName={parentDef?.name || 'Parent'} onClose={() => setModal(null)}
      onAdd={d => act(`“${d.v}” added`, () => mastersApi.addValue(def.key, d), () => setModal(null))} />}
    {modal?.t === 'imp' && def && page && <ImportModal def={def} parents={page.parents} parentName={parentDef?.name || 'Parent'} onClose={() => setModal(null)}
      onImport={(values, parent_id) => { if (!values.length) return info('Paste at least one value'); void act('', () => mastersApi.importValues(def.key, values, parent_id).then(r => success(`${r.added} value(s) imported`)), () => setModal(null)) }} />}
    {modal?.t === 'form' && def && <AddToFormModal def={def} modules={tree.modules} onClose={() => setModal(null)}
      onAdd={(module, label) => act(`Lookup field “${label}” added to the ${tree.modules.find(m => m.k === module)?.l || module} form`, () => mastersApi.addToForm(def.key, module, label), () => setModal(null))} />}
  </div>
}

/* ───────────── New master (prototype mstNew + parent master) ───────────── */
function NewMasterModal({ tree, onClose, onCreate }: { tree: Tree; onClose: () => void; onCreate: (d: { name: string; description: string; kind: string; parent_key: string | null; values: string[]; add_to: string | null }) => void }) {
  const { info } = useToast()
  const [d, setD] = useState({ name: '', description: '', kind: tree.kinds[0], parent_key: tree.masters[0]?.key || '', values: '', addField: true, module: 'customers' })
  const hier = d.kind === 'Hierarchy (parent › child)'
  return <Modal title="New master" width={520} onClose={onClose}
    foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => { if (!d.name.trim()) return info('Name the master')
      onCreate({ name: d.name.trim(), description: d.description.trim(), kind: d.kind, parent_key: hier ? d.parent_key : null, values: d.values.split('\n').map(x => x.trim()).filter(Boolean), add_to: d.addField ? d.module : null }) }}>Create master</button></>}>
    <div className="fg">
      <div className="f1"><label>Master name</label><input className="in" autoFocus placeholder="e.g. Contract types, Territories, Competitor tiers" value={d.name} onChange={e => setD({ ...d, name: e.target.value })} /></div>
      <div className="f1"><label>Description</label><input className="in" placeholder="What is this list used for?" value={d.description} onChange={e => setD({ ...d, description: e.target.value })} /></div>
      <div className="f1"><label>Type</label><select className="in" value={d.kind} onChange={e => setD({ ...d, kind: e.target.value })}>{tree.kinds.map(k => <option key={k}>{k}</option>)}</select></div>
      {hier && <div className="f1"><label>Parent master</label><select className="in" value={d.parent_key} onChange={e => setD({ ...d, parent_key: e.target.value })}>{tree.masters.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}</select>
        <small>Every value of this master will pick one value of the parent (like Customer segments › Customer sub segments).</small></div>}
      <div className="f1"><label>Initial values (one per line)</label><textarea className="in" rows={5} value={d.values} onChange={e => setD({ ...d, values: e.target.value })} /></div>
      <div className="f1"><label className="row"><input type="checkbox" checked={d.addField} onChange={e => setD({ ...d, addField: e.target.checked })} /> Also add a lookup field for this master in:</label>
        <select className="in" value={d.module} disabled={!d.addField} onChange={e => setD({ ...d, module: e.target.value })}>{tree.modules.map(m => <option key={m.k} value={m.k}>{m.l}</option>)}</select></div>
    </div></Modal>
}

function RenameModal({ name, desc, onClose, onSave }: { name: string; desc: string; onClose: () => void; onSave: (name: string, description: string) => void }) {
  const [n, setN] = useState(name)
  const [ds, setDs] = useState(desc === 'Custom master' ? '' : desc)
  return <Modal title="Rename master" width={440} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => n.trim() && onSave(n.trim(), ds.trim())}>Save</button></>}>
    <div className="fg"><div className="f1"><label>Master name</label><input className="in" autoFocus value={n} onChange={e => setN(e.target.value)} /></div>
      <div className="f1"><label>Description</label><input className="in" value={ds} onChange={e => setDs(e.target.value)} /></div></div></Modal>
}

function AddValueModal({ def, parents, parentName, onClose, onAdd }: { def: MasterPage['def']; parents: { id: number; v: string }[]; parentName: string; onClose: () => void; onAdd: (d: { v: string; attrs: Record<string, string>; parent_id: number | null }) => void }) {
  const { info } = useToast()
  const [v, setV] = useState('')
  const [attrs, setAttrs] = useState<Record<string, string>>({})
  const [pid, setPid] = useState<number | null>(parents[0]?.id ?? null)
  const submit = () => { if (!v.trim()) return info('Enter a value'); if (def.parent_key && !pid) return info(`Choose the ${parentName.toLowerCase()}`); onAdd({ v: v.trim(), attrs, parent_id: def.parent_key ? pid : null }) }
  return <Modal title={`Add value · ${def.name}`} width={460} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={submit}>Add</button></>}>
    <div className="fg">
      <div className="f1"><label>Value</label><input className="in" autoFocus value={v} onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit() }} /></div>
      {def.attrs.map(a => <div key={a} className="f1"><label>{a}</label><input className="in" value={attrs[a] || ''} onChange={e => setAttrs({ ...attrs, [a]: e.target.value })} /></div>)}
      {def.parent_key && <div className="f1"><label>{parentName}</label><select className="in" value={pid ?? ''} onChange={e => setPid(e.target.value ? Number(e.target.value) : null)}>{!parents.length && <option value="">— add values to the parent master first —</option>}{parents.map(p => <option key={p.id} value={p.id}>{p.v}</option>)}</select></div>}
    </div></Modal>
}

function ImportModal({ def, parents, parentName, onClose, onImport }: { def: MasterPage['def']; parents: { id: number; v: string }[]; parentName: string; onClose: () => void; onImport: (values: string[], parent_id: number | null) => void }) {
  const [txt, setTxt] = useState('')
  const [pid, setPid] = useState<number | null>(parents[0]?.id ?? null)
  return <Modal title={`Import · ${def.name}`} width={480} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => onImport(txt.split(/\r?\n|,/).map(x => x.trim()).filter(Boolean), def.parent_key ? pid : null)}>Import</button></>}>
    <div className="fg"><div className="f1"><label>Values (one per line, or comma separated)</label><textarea className="in" rows={8} autoFocus value={txt} onChange={e => setTxt(e.target.value)} placeholder={'Value 1\nValue 2\nValue 3'} /></div>
      {def.parent_key && <div className="f1"><label>{parentName} for the imported values</label><select className="in" value={pid ?? ''} onChange={e => setPid(e.target.value ? Number(e.target.value) : null)}>{parents.map(p => <option key={p.id} value={p.id}>{p.v}</option>)}</select></div>}</div>
    <p className="mu mt" style={{ fontSize: 12 }}>Existing values are skipped; new ones are appended in order.</p></Modal>
}

function AddToFormModal({ def, modules, onClose, onAdd }: { def: MasterPage['def']; modules: { k: string; l: string }[]; onClose: () => void; onAdd: (module: string, label: string) => void }) {
  const [m, setM] = useState(modules[0]?.k || 'customers')
  const [label, setLabel] = useState(def.name)
  return <Modal title={`Add to a form · ${def.name}`} width={440} onClose={onClose} foot={<><span className="fl" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={() => onAdd(m, label.trim() || def.name)}>Add lookup field</button></>}>
    <div className="fg"><div className="f1"><label>Module form</label><select className="in" value={m} onChange={e => setM(e.target.value)}>{modules.map(x => <option key={x.k} value={x.k}>{x.l}</option>)}</select></div>
      <div className="f1"><label>Field label</label><input className="in" value={label} onChange={e => setLabel(e.target.value)} /></div></div>
    <p className="mu mt" style={{ fontSize: 12 }}>A “Master lookup” field is added to the form layout in Customization Studio; the values of this master become its dropdown.</p></Modal>
}
