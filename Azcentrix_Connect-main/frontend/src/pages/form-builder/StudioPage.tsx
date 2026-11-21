// Customization Studio – prototype v17 R.forms(): subnav Layouts & fields · Picklists · Custom objects · Validation rules.
// Layouts & fields = original R.forms: crumb Administration · "Layouts & fields" · company · "<Module> form" select · Preview · Save layout;
//   three columns: Add field (FTYPES) · "<Module> · N fields  Drag to reorder" canvas of .fld rows · Field properties (label, type, width,
//   master list, options, help text, required, show only when, delete).  Properties edit the draft; "Save layout" writes it in one call.
// Picklists = Masters pointer + "Masters used in forms".  Custom objects = cards → records grid + Add record.  Validation rules = list + New rule.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol, type GridMenuItem } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import { Panel, Tbl } from '@/pages/customers/kit'
import { errMsg, fd, studioApi, type CoField, type CustomObject, type CustomRecord, type LField, type Layout, type LayoutMeta, type Picklists, type Rule } from './studioApi'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'
import './studio.css'

const TABS = ['Layouts & fields', 'Picklists', 'Custom objects', 'Validation rules'] as const
type Tab = typeof TABS[number]
const Sw = ({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) => (
  <label className="sw"><input type="checkbox" checked={on} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.checked)} /><i /></label>
)

export default function StudioPage() {
  const [sp, setSp] = useSearchParams()
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') || '') ? (sp.get('tab') as Tab) : 'Layouts & fields'
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', t); n.delete('obj'); return n })
  return (
    <div className="bwi">
      <div className="snav" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      {tab === 'Layouts & fields' && <LayoutsTab />}
      {tab === 'Picklists' && <PicklistsTab />}
      {tab === 'Custom objects' && <ObjectsTab />}
      {tab === 'Validation rules' && <RulesTab />}
    </div>
  )
}

/* ───────────── Layouts & fields ───────────── */
/** prototype inputFor(): a disabled preview input for the canvas / preview modal */
function FieldInput({ f, masters }: { f: LField; masters: { k: string; l: string }[] }) {
  const t = f.type
  if (t === 'textarea') return <textarea className="in" rows={2} disabled placeholder={f.label} />
  if (t === 'checkbox') return <label className="row" style={{ gap: 6 }}><input type="checkbox" disabled /> <small>{f.label}</small></label>
  if (t === 'select' || t === 'multi') return <select className="in" disabled multiple={t === 'multi'}><option>{(f.opts[0] || 'Choose…')}</option></select>
  if (t === 'master') return <select className="in" disabled><option>{masters.find(m => m.k === f.master)?.l || 'Master lookup'}…</option></select>
  if (t === 'user') return <select className="in" disabled><option>Choose user…</option></select>
  if (t === 'lookup') return <input className="in" disabled placeholder="Search customer…" />
  if (t === 'file') return <input className="in" type="file" disabled />
  if (t === 'formula') return <input className="in" disabled value="= computed" readOnly />
  return <input className="in" type={t === 'number' || t === 'currency' ? 'number' : t === 'date' ? 'date' : t === 'email' ? 'email' : 'text'} disabled placeholder={t === 'currency' ? '₹' : f.label} />
}

function LayoutsTab() {
  const navigate = useNavigate()
  const { success, error, info } = useToast()
  const [meta, setMeta] = useState<LayoutMeta | null>(null)
  const [mod, setMod] = useState('tenders')
  const [saved, setSaved] = useState<Layout | null>(null)
  const [fields, setFields] = useState<LField[]>([])
  const [sel, setSel] = useState(0)
  const [drag, setDrag] = useState<{ from: number; over: number | null } | null>(null)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => { studioApi.meta().then(setMeta).catch(e => error(errMsg(e, 'Could not load the studio'))) }, [error])
  useEffect(() => { setSaved(null); studioApi.layout(mod).then(l => { setSaved(l); setFields(l.fields); setSel(0) }).catch(e => error(errMsg(e, 'Could not load the form layout'))) }, [mod, error])
  const dirty = useMemo(() => !!saved && JSON.stringify(saved.fields) !== JSON.stringify(fields), [saved, fields])
  const can = !!meta?.can_manage
  const f = fields[sel]
  const typeLabel = (t: string) => meta?.types.find(x => x.k === t)?.l || t
  const upd = (patch: Partial<LField>) => setFields(fs => fs.map((x, i) => (i === sel ? { ...x, ...patch } : x)))
  const add = (t: string) => {
    const n = typeLabel(t)
    setFields(fs => [...fs, { id: null, key: '', label: `New ${n.toLowerCase()}`, type: t, sys: false, req: false, w: 1, opts: t === 'select' || t === 'multi' ? ['Option 1', 'Option 2'] : [],
      help: '', visible: true, master: t === 'master' ? (meta?.masters[0]?.k || null) : null, show_when: 'Always', sort: fs.length }])
    setSel(fields.length)
    info('Field added – it will appear in the New dialog after you save the layout')
  }
  const del = () => { if (!f || f.sys) return; setFields(fs => fs.filter((_, i) => i !== sel)); setSel(0) }
  const move = (from: number, to: number) => { if (from === to) return; setFields(fs => { const n = [...fs]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n }); setSel(to) }
  const save = async () => {
    setSaving(true)
    try { const l = await studioApi.saveLayout(mod, fields); setSaved(l); setFields(l.fields); setSel(s => Math.min(s, l.fields.length - 1)); success('Form layout saved – applies to New and Edit dialogs') }
    catch (e) { error(errMsg(e, 'Could not save the layout')) }
    finally { setSaving(false) }
  }
  if (!meta) return <div className="empty">Loading…</div>
  return <>
    <div className="pg">
      <div><div className="crumb">Administration</div><h1>Layouts &amp; fields</h1></div>
      <span className="cnt">{saved?.label || ''}{dirty && <span className="twarn"> · unsaved changes</span>}</span>
      <span className="fl" />
      <select className="in" style={{ width: 200 }} value={mod} aria-label="Form" onChange={e => setMod(e.target.value)}>{meta.modules.map(m => <option key={m.k} value={m.k}>{m.l} form</option>)}</select>
      <button type="button" className="btn" onClick={() => setPreview(true)}><Ic n="eye" /> Preview</button>
      {can && <button type="button" className="btn p" disabled={saving || !dirty} onClick={save}>Save layout</button>}
    </div>
    <div className="fbg">
      <div className="panel"><div className="ph">Add field</div><div className="list">
        {meta.types.map(t => <div key={t.k} role="button" tabIndex={can ? 0 : -1} onClick={() => can && add(t.k)} onKeyDown={e => { if (can && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); add(t.k) } }}><Ic n="plus" /> {t.l}</div>)}
      </div></div>
      <div className="panel"><div className="ph">{saved?.label || '…'} · {fields.length} fields<span className="fl" /><small>Drag to reorder</small></div>
        <div className="cv">{saved === null ? <div className="empty">Loading…</div> : fields.map((d, i) => <div key={`${d.key || 'new'}-${i}`} className={`fld ${i === sel ? 'on' : ''} ${d.visible ? '' : 'off'} ${drag?.over === i ? 'drop' : ''}`}
          draggable={can} onDragStart={() => setDrag({ from: i, over: null })} onDragOver={e => { e.preventDefault(); setDrag(x => x ? { ...x, over: i } : x) }}
          onDrop={e => { e.preventDefault(); if (drag) move(drag.from, i); setDrag(null) }} onDragEnd={() => setDrag(null)}
          onClick={() => setSel(i)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setSel(i); if (can && e.altKey && e.key === 'ArrowUp' && i > 0) move(i, i - 1); if (can && e.altKey && e.key === 'ArrowDown' && i < fields.length - 1) move(i, i + 1) }}>
          <span className="grip"><Ic n="grip" /></span>
          <div className="fl"><b>{d.label}</b>{d.req && <span className="tbad"> *</span>}<small>{typeLabel(d.type)} · {d.w > 1 ? 'full width' : 'half width'}{d.sys ? '' : ' · custom'}{d.visible ? '' : ' · hidden'}</small></div>
          <span className="prev"><FieldInput f={d} masters={meta.masters} /></span>
        </div>)}</div>
      </div>
      <div className="panel"><div className="ph">Field properties</div><div className="pb">{f ? <div className="fg one">
        <div><label>Label</label><input className="in" value={f.label} disabled={!can} onChange={e => upd({ label: e.target.value })} /></div>
        <div><label>Field type</label><select className="in" value={f.type} disabled={!can || f.sys} onChange={e => upd({ type: e.target.value, master: e.target.value === 'master' ? (f.master || meta.masters[0]?.k || null) : null })}>
          {meta.types.map(t => <option key={t.k} value={t.k}>{t.l}</option>)}{!meta.types.some(t => t.k === f.type) && <option value={f.type}>{f.type}</option>}</select></div>
        <div><label>Width</label><select className="in" value={f.w} disabled={!can} onChange={e => upd({ w: Number(e.target.value) as 1 | 2 })}><option value={1}>Half</option><option value={2}>Full</option></select></div>
        {f.type === 'master' && <div><label>Master list</label><select className="in" value={f.master || ''} disabled={!can} onChange={e => upd({ master: e.target.value || null })}>
          {meta.masters.map(m => <option key={m.k} value={m.k}>{m.l}</option>)}</select><small className="mu">Create new masters in Directory → Masters</small></div>}
        {(f.type === 'select' || f.type === 'multi') && <div><label>Options (one per line)</label><textarea className="in" rows={3} value={f.opts.join('\n')} disabled={!can} onChange={e => upd({ opts: e.target.value.split('\n').map(x => x.trim()).filter(Boolean) })} /></div>}
        <div><label>Help text</label><input className="in" value={f.help} disabled={!can} onChange={e => upd({ help: e.target.value })} /></div>
        <div className="row" style={{ gap: 12 }}><label className="row" style={{ gap: 6 }}><Sw on={f.req} disabled={!can} label="Required" onChange={v => upd({ req: v })} /> Required</label>
          <label className="row" style={{ gap: 6 }}><Sw on={f.visible} disabled={!can} label="Visible" onChange={v => upd({ visible: v })} /> Visible</label></div>
        <div><label>Show only when…</label><select className="in" value={f.show_when} disabled={!can} onChange={e => upd({ show_when: e.target.value })}>{meta.show_when.map(s => <option key={s}>{s}</option>)}{!meta.show_when.includes(f.show_when) && <option>{f.show_when}</option>}</select></div>
        <div className="row mt">{f.sys ? <small className="mu">System field – it can be hidden or relabelled, not deleted.</small>
          : can && <button type="button" className="btn s d" onClick={del}><Ic n="trash" /> Delete field</button>}</div>
      </div> : <div className="empty">Select a field</div>}</div></div>
    </div>
    {preview && <Modal title={`Form preview – ${saved?.label || ''}`} width={680} onClose={() => setPreview(false)} foot={<button type="button" className="btn" onClick={() => setPreview(false)}>Close</button>}>
      <div className="pvf">{fields.filter(x => x.visible).map((x, i) => <div key={i} className={x.w > 1 ? 'f2' : ''}><label>{x.label}{x.req && <span className="tbad"> *</span>}</label><FieldInput f={x} masters={meta.masters} />{x.help && <small className="mu">{x.help}</small>}{x.show_when !== 'Always' && <small className="mu">Shown only when {x.show_when}</small>}</div>)}</div>
    </Modal>}
    {!can && <div className="note inf mt">You can view layouts. Ask an administrator for the “Manage Form Builder” permission to change them.</div>}
    <div className="mt"><small className="mu">The classic field editor is still available at <a onClick={() => navigate('/form-builder/classic')} style={{ cursor: 'pointer', color: 'var(--bw-ac)' }}>Form Builder (classic)</a>.</small></div>
  </>
}

/* ───────────── Picklists ───────────── */
function PicklistsTab() {
  const navigate = useNavigate()
  const { error } = useToast()
  const [d, setD] = useState<Picklists | null>(null)
  useEffect(() => { studioApi.picklists().then(setD).catch(e => error(errMsg(e, 'Could not load masters'))) }, [error])
  return <>
    <div className="pg"><div><h1>Masters</h1><div className="mu">Controlled lists now live in <b>Directory → Masters</b>. Any master – standard or one you create – can be added to a form as a <b>Master lookup</b> field.</div></div>
      <span className="fl" /><button type="button" className="btn p" onClick={() => navigate('/masters')}>Open Masters</button><button type="button" className="btn" onClick={() => navigate('/masters')}><Ic n="plus" /> New master</button></div>
    <Panel title="Masters used in forms" z>{d === null ? <div className="empty">Loading…</div> : d.used.length ? <Tbl<Picklists['used'][number]> cols={[
      { k: 'l', t: 'Master', fn: r => <b>{r.l}</b> }, { k: 'u', t: 'Used in', wr: true, fn: r => <>{r.u.map((x, i) => <span key={i}>{x.module} · {x.field}{i < r.u.length - 1 && <br />}</span>)}</> },
    ]} rows={d.used} rowKey={r => r.k} /> : <div className="empty">No master is used in a form yet. Add a field of type <b>Master lookup</b> in Layouts &amp; fields.</div>}</Panel>
    {d && <div className="mt"><small className="mu">Available masters: {d.masters.map(m => m.l).join(' · ')}</small></div>}
  </>
}

/* ───────────── Custom objects ───────────── */
const CO_TYPES = [['text', 'Text'], ['textarea', 'Multi-line text'], ['number', 'Number'], ['currency', 'Currency (₹)'], ['date', 'Date'], ['select', 'Dropdown'], ['checkbox', 'Checkbox'], ['user', 'User'], ['email', 'Email'], ['phone', 'Phone']] as const

function ObjectsTab() {
  const [sp, setSp] = useSearchParams()
  const { success, error } = useToast()
  const [list, setList] = useState<CustomObject[] | null>(null)
  const [meta, setMeta] = useState<LayoutMeta | null>(null)
  const [creating, setCreating] = useState(false)
  const [del, setDel] = useState<CustomObject | null>(null)
  const openId = sp.get('obj') ? Number(sp.get('obj')) : null
  const load = useCallback(() => studioApi.objects().then(setList).catch(e => error(errMsg(e, 'Could not load custom objects'))), [error])
  useEffect(() => { load(); studioApi.meta().then(setMeta).catch(() => undefined) }, [load])
  const can = !!meta?.can_manage
  const open = (id: number | null) => setSp(s => { const n = new URLSearchParams(s); if (id) n.set('obj', String(id)); else n.delete('obj'); return n })
  if (openId) return <ObjectRecords id={openId} can={can} onBack={() => { open(null); load() }} />
  return <>
    <div className="pg"><div><h1>Custom objects</h1><div className="mu">Model anything your business tracks beyond the standard modules.</div></div>
      <span className="fl" />{can && <button type="button" className="btn p" onClick={() => setCreating(true)}><Ic n="plus" /> New object</button>}</div>
    {list === null ? <div className="empty">Loading…</div> : list.length ? <div className="g g3">{list.map(o => <Panel key={o.id} title={o.p} className="cocard"
      act={can ? <button type="button" className="btn s g" aria-label="Delete object" onClick={() => setDel(o)}><Ic n="trash" /></button> : undefined}>
      <div className="pills">{o.f.map(f => <span key={f.k} className="pill mu">{f.l}</span>)}</div>
      <div className="row"><small className="fl">{o.rows} record{o.rows === 1 ? '' : 's'}</small><button type="button" className="btn s" onClick={() => open(o.id)}>Open</button></div>
    </Panel>)}</div> : <div className="panel"><div className="empty">No custom objects yet. Create one to track site surveys, assets, service visits – anything with its own fields.</div></div>}
    {creating && <NewObjectModal onClose={() => setCreating(false)} onDone={() => { setCreating(false); load(); success('Custom object created') }} />}
    {del && <Modal title="Remove custom object" width={440} onClose={() => setDel(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => { try { await studioApi.deleteObject(del.id); setDel(null); load(); success('Custom object removed') } catch (e) { error(errMsg(e)) } }}>Remove</button></>}>
      <p style={{ margin: 0 }}>Remove <b>{del.p}</b> and hide its {del.rows} record{del.rows === 1 ? '' : 's'}?</p></Modal>}
  </>
}

function NewObjectModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [n, setN] = useState(''); const [p, setP] = useState('')
  const [fields, setFields] = useState<{ l: string; t: string; o: string; req: boolean }[]>([{ l: 'Name', t: 'text', o: '', req: true }, { l: 'Owner', t: 'user', o: '', req: false }, { l: 'Status', t: 'select', o: 'Planned, In progress, Completed', req: false }, { l: 'Date', t: 'date', o: '', req: false }])
  const upd = (i: number, patch: Partial<typeof fields[number]>) => setFields(fs => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const save = async () => {
    if (!n.trim()) return error('Name the object')
    const fl = fields.filter(f => f.l.trim()).map(f => ({ l: f.l.trim(), t: f.t, o: f.t === 'select' ? f.o.split(',').map(x => x.trim()).filter(Boolean) : [], req: f.req }))
    if (!fl.length) return error('Add at least one field')
    try { await studioApi.createObject({ name: n.trim(), plural: p.trim() || n.trim() + 's', fields: fl }); onDone() } catch (e) { error(errMsg(e)) }
  }
  return <Modal title="New custom object" width={600} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={save}>Create object</button></>}>
    <div className="fg"><div><label>Singular name</label><input className="in" value={n} onChange={e => setN(e.target.value)} placeholder="Site survey" autoFocus /></div>
      <div><label>Plural name</label><input className="in" value={p} onChange={e => setP(e.target.value)} placeholder="Site surveys" /></div>
      <div className="f1"><label>Fields</label>
        {fields.map((f, i) => <div key={i} className="row mb" style={{ gap: 6 }}>
          <input className="in sm" style={{ flex: 2 }} placeholder="Field label" value={f.l} onChange={e => upd(i, { l: e.target.value })} />
          <select className="in sm" style={{ width: 130 }} value={f.t} onChange={e => upd(i, { t: e.target.value })}>{CO_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {f.t === 'select' && <input className="in sm" style={{ flex: 2 }} placeholder="Options, comma separated" value={f.o} onChange={e => upd(i, { o: e.target.value })} />}
          <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={f.req} onChange={e => upd(i, { req: e.target.checked })} /><small>Req.</small></label>
          <button type="button" className="btn s g" aria-label="Remove field" onClick={() => setFields(fs => fs.filter((_, j) => j !== i))}><Ic n="x" /></button></div>)}
        <button type="button" className="btn s" onClick={() => setFields(fs => [...fs, { l: '', t: 'text', o: '', req: false }])}><Ic n="plus" /> Field</button></div></div>
  </Modal>
}

function ObjectRecords({ id, can, onBack }: { id: number; can: boolean; onBack: () => void }) {
  const { success, error } = useToast()
  const [obj, setObj] = useState<CustomObject | null>(null)
  const [p, setP] = useState<{ q: string; sorts: [string, number][]; offset: number; limit: number }>({ q: '', sorts: [], offset: 0, limit: 25 })
  const [data, setData] = useState<{ items: CustomRecord[]; total: number; loading: boolean }>({ items: [], total: 0, loading: true })
  const [rev, setRev] = useState(0)
  const [edit, setEdit] = useState<CustomRecord | 'new' | null>(null)
  const [del, setDel] = useState<CustomRecord | null>(null)
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => studioApi.records(id, p).then(r => { if (live) { setObj(r.object); setData({ items: r.items, total: r.total, loading: false }) } })
      .catch(e => { if (live) { setData(d => ({ ...d, loading: false })); error(errMsg(e, 'Could not load records')) } }), 120)
    return () => { live = false; clearTimeout(t) }
  }, [id, p, rev, error])
  const fmt = (f: CoField, v: unknown): ReactNode => f.t === 'checkbox' ? (v ? '✓' : '—') : f.t === 'date' ? fd(String(v || '')) : f.t === 'currency' && v !== '' && v !== undefined ? '₹' + Number(v).toLocaleString('en-IN') : String(v ?? '')
  const cols = useMemo<GridCol<CustomRecord>[]>(() => {
    const own: GridCol<CustomRecord>[] = (obj?.f || []).map(f => ({ k: f.k, t: f.l, w: 170, fn: (r: CustomRecord) => fmt(f, r[f.k]), txt: (r: CustomRecord) => String(r[f.k] ?? '') }))
    const created: GridCol<CustomRecord> = { k: 'created', t: 'Created', w: 120, date: true, fn: r => fd(r.created), txt: r => r.created || '' }
    return [...own, created]
  }, [obj])
  const menu = (r: CustomRecord): GridMenuItem[] => can ? [{ l: 'Edit', i: <Ic n="edit" />, fn: () => setEdit(r) }, { l: 'Delete', i: <Ic n="trash" />, danger: true, fn: () => setDel(r) }] : []
  return <>
    <div className="pg"><div><div className="crumb"><a onClick={onBack} style={{ cursor: 'pointer' }}>Custom objects</a> / {obj?.n || '…'}</div><h1>{obj?.p || '…'}</h1></div>
      <span className="cnt">{data.total} records</span><span className="fl" />{can && obj && <button type="button" className="btn p" onClick={() => setEdit('new')}><Ic n="plus" /> Add record</button>}</div>
    <div className="panel" aria-busy={data.loading}>{obj && <BwGrid id={`co-${id}`} cols={cols} rows={data.items} rid={r => String(r.id)} onRow={can ? r => setEdit(r) : undefined} menu={menu}
      server={{ total: data.total, onChange: s => setP(x => ({ ...x, offset: s.offset, limit: s.limit, sorts: s.sorts })) }} onQuery={s => setP(x => ({ ...x, q: s.q, offset: 0 }))}
      empty={data.loading ? 'Loading…' : `No ${obj.p.toLowerCase()} yet.`} />}</div>
    {edit && obj && <RecordModal obj={obj} rec={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); setRev(r => r + 1); success(edit === 'new' ? 'Record added' : 'Record updated') }} />}
    {del && <Modal title="Delete record" width={400} onClose={() => setDel(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => { try { await studioApi.deleteRecord(id, del.id); setDel(null); setRev(r => r + 1); success('Record deleted') } catch (e) { error(errMsg(e)) } }}>Delete</button></>}>
      <p style={{ margin: 0 }}>Delete this record permanently?</p></Modal>}
  </>
}

function RecordModal({ obj, rec, onClose, onDone }: { obj: CustomObject; rec: CustomRecord | null; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [d, setD] = useState<Record<string, unknown>>(() => Object.fromEntries(obj.f.map(f => [f.k, rec ? rec[f.k] ?? '' : (f.t === 'checkbox' ? false : '')])))
  const save = async () => { try { await studioApi.saveRecord(obj.id, d, rec?.id); onDone() } catch (e) { error(errMsg(e)) } }
  const set = (k: string, v: unknown) => setD(x => ({ ...x, [k]: v }))
  return <Modal title={rec ? `Edit ${obj.n.toLowerCase()}` : `New ${obj.n.toLowerCase()}`} width={520} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={save}>{rec ? 'Save' : 'Add'}</button></>}>
    <div className="fg">{obj.f.map(f => <div key={f.k} className={f.t === 'textarea' ? 'f1' : ''}><label>{f.l}{f.req && <span className="tbad"> *</span>}</label>
      {f.t === 'textarea' ? <textarea className="in" rows={3} value={String(d[f.k] ?? '')} onChange={e => set(f.k, e.target.value)} />
        : f.t === 'checkbox' ? <label className="row" style={{ gap: 6, height: 30 }}><input type="checkbox" checked={!!d[f.k]} onChange={e => set(f.k, e.target.checked)} /> <small>Yes</small></label>
        : f.t === 'select' ? <select className="in" value={String(d[f.k] ?? '')} onChange={e => set(f.k, e.target.value)}><option value="">—</option>{f.o.map(o => <option key={o}>{o}</option>)}</select>
        : <input className="in" type={f.t === 'number' || f.t === 'currency' ? 'number' : f.t === 'date' ? 'date' : f.t === 'email' ? 'email' : 'text'} value={String(d[f.k] ?? '')} onChange={e => set(f.k, e.target.value)} />}
    </div>)}</div>
  </Modal>
}

/* ───────────── Validation rules ───────────── */
function RulesTab() {
  const { success, error } = useToast()
  const [d, setD] = useState<{ items: Rule[]; objects: string[] } | null>(null)
  const [meta, setMeta] = useState<LayoutMeta | null>(null)
  const [edit, setEdit] = useState<Rule | 'new' | null>(null)
  const [del, setDel] = useState<Rule | null>(null)
  const load = useCallback(() => studioApi.rules().then(setD).catch(e => error(errMsg(e, 'Could not load validation rules'))), [error])
  useEffect(() => { load(); studioApi.meta().then(setMeta).catch(() => undefined) }, [load])
  const can = !!meta?.can_manage
  const toggle = async (r: Rule, on: boolean) => {
    setD(x => x ? { ...x, items: x.items.map(i => i.id === r.id ? { ...i, on } : i) } : x)
    try { await studioApi.toggleRule(r.id, on) } catch (e) { error(errMsg(e)); load() }
  }
  return <>
    <div className="pg"><div><h1>Validation rules</h1><div className="mu">Block bad data at the point of entry.</div></div><span className="fl" />{can && <button type="button" className="btn p" onClick={() => setEdit('new')}><Ic n="plus" /> New rule</button>}</div>
    {d === null ? <div className="empty">Loading…</div> : d.items.length ? <div className="vr">{d.items.map(r => <div key={r.id}>
      <Sw on={r.on} disabled={!can} label={r.n} onChange={v => toggle(r, v)} />
      <span className="fl"><b>{r.n}</b><br /><small>{r.o} · <code>{r.f}</code> · message: “{r.m}”</small></span>
      {can && <><button type="button" className="btn s g" aria-label="Edit" onClick={() => setEdit(r)}><Ic n="edit" /></button><button type="button" className="btn s g" aria-label="Delete" onClick={() => setDel(r)}><Ic n="trash" /></button></>}
    </div>)}</div> : <div className="panel"><div className="empty">No validation rules yet.</div></div>}
    <div className="note inf mt">Rules are stored now and enforced on the module forms once the modules are connected to the studio.</div>
    {edit && d && <RuleModal rule={edit === 'new' ? null : edit} objects={d.objects} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); success(edit === 'new' ? 'Rule created' : 'Rule updated') }} />}
    {del && <Modal title="Remove rule" width={400} onClose={() => setDel(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => { try { await studioApi.deleteRule(del.id); setDel(null); load(); success('Rule removed') } catch (e) { error(errMsg(e)) } }}>Remove</button></>}>
      <p style={{ margin: 0 }}>Remove <b>{del.n}</b>?</p></Modal>}
  </>
}

function RuleModal({ rule, objects, onClose, onDone }: { rule: Rule | null; objects: string[]; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [n, setN] = useState(rule?.n || ''); const [o, setO] = useState(rule?.o || objects[0] || 'Deals'); const [f, setF] = useState(rule?.f || 'value > 0'); const [m, setM] = useState(rule?.m || '')
  const save = async () => { try { await studioApi.saveRule({ name: n, object: o, formula: f, message: m }, rule?.id); onDone() } catch (e) { error(errMsg(e)) } }
  return <Modal title={rule ? 'Edit validation rule' : 'New validation rule'} width={520} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={save}>Save rule</button></>}>
    <div className="fg"><div className="f1"><label>Rule name</label><input className="in" value={n} onChange={e => setN(e.target.value)} autoFocus /></div>
      <div><label>Object</label><select className="in" value={o} onChange={e => setO(e.target.value)}>{objects.map(x => <option key={x}>{x}</option>)}</select></div>
      <div><label>Formula</label><input className="in mono" value={f} onChange={e => setF(e.target.value)} /></div>
      <div className="f1"><label>Error message</label><input className="in" value={m} onChange={e => setM(e.target.value)} placeholder="Shown to the user when the rule fails" /></div></div>
  </Modal>
}
