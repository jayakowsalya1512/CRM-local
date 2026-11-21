// Roles & Security – prototype v17 R.roles(): subnav Roles & permissions · Sharing rules · Field-level security.
// Roles & permissions: crumb "Administration" · "Roles & permission" · Clone role · + New role; left list of roles (N users);
// right panel: role name, Data scope select, matrix Module × View · Create · Edit · Delete · Approve · Export · All.
// Sharing rules: "Record sharing rules" + New rule → table Object · Rule · Shared with · Access.
// Field-level security: module select → table Field × roles with Edit / Read / Hidden.
import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/pages/notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'
import { Panel, Pill, Tbl } from '@/pages/customers/kit'
import { admin360Api, errMsg, type FieldSecurity, type Matrix, type MatrixRole, type SharingRule } from '@/pages/settings/admin360Api'
import '@/pages/notifications/inbox.css'
import '@/pages/customers/c360.css'
import '@/pages/settings/appSettings.css'
import '@/pages/settings/admin360.css'

const TABS = ['Roles & permissions', 'Sharing rules', 'Field-level security'] as const
type Tab = typeof TABS[number]

export default function RolesSecurityPage() {
  const [sp, setSp] = useSearchParams()
  const tab: Tab = (TABS as readonly string[]).includes(sp.get('tab') || '') ? (sp.get('tab') as Tab) : 'Roles & permissions'
  const setTab = (t: Tab) => setSp(s => { const n = new URLSearchParams(s); n.set('tab', t); return n })
  return (
    <div className="bwi">
      <div className="snav" role="tablist">{TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={tab === t} className={`tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}</div>
      {tab === 'Roles & permissions' && <RolesTab />}
      {tab === 'Sharing rules' && <SharingTab />}
      {tab === 'Field-level security' && <FieldSecurityTab />}
    </div>
  )
}

/* ───────────── Roles & permissions ───────────── */
function RolesTab() {
  const { success, error } = useToast()
  const [m, setM] = useState<Matrix | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [newRole, setNewRole] = useState<{ clone: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => admin360Api.matrix().then(x => { setM(x); setSel(s => (s && x.roles.some(r => r.id === s) ? s : (x.roles[0]?.id ?? null))) }).catch(e => error(errMsg(e, 'Could not load roles'))), [error])
  useEffect(() => { load() }, [load])
  if (!m) return <div className="empty">Loading…</div>
  const role = m.roles.find(r => r.id === sel) || m.roles[0]
  const can = m.can.manage
  const granted = new Set(role ? (m.grants[String(role.id)] || []) : [])
  const allPermIds = (mod: Matrix['modules'][number]) => [...Object.values(mod.acts).map(p => p.id), ...mod.more.map(p => p.id)]

  const commit = async (ids: Set<number>, scope = role!.scope, label = 'Permissions updated') => {
    setSaving(true)
    try {
      await admin360Api.setPermissions(role!.id, Array.from(ids), m.modules.map(x => ({ module: x.key, data_scope: scope })))
      setM(x => x ? { ...x, grants: { ...x.grants, [String(role!.id)]: Array.from(ids) }, roles: x.roles.map(r => r.id === role!.id ? { ...r, scope } : r) } : x)
      success(label)
    } catch (e) { error(errMsg(e, 'Could not save')) }
    finally { setSaving(false) }
  }
  const toggle = (id: number, on: boolean) => { const n = new Set(granted); on ? n.add(id) : n.delete(id); commit(n) }
  const toggleAll = (mod: Matrix['modules'][number], on: boolean) => { const n = new Set(granted); allPermIds(mod).forEach(id => on ? n.add(id) : n.delete(id)); commit(n) }

  return <>
    <div className="pg">
      <div><div className="crumb">Administration</div><h1>Roles &amp; permission</h1></div>
      <span className="fl" />
      {can && <button type="button" className="btn" disabled={!role} onClick={() => setNewRole({ clone: true })}><Ic n="copy" /> Clone role</button>}
      {can && <button type="button" className="btn p" onClick={() => setNewRole({ clone: false })}><Ic n="plus" /> New role</button>}
    </div>
    <div className="split rolesp">
      <div className="panel"><div className="side" role="tablist" aria-label="Roles">
        {m.roles.map(r => <div key={r.id} role="tab" tabIndex={0} aria-selected={r.id === role?.id} className={r.id === role?.id ? 'on' : ''} onClick={() => setSel(r.id)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSel(r.id) } }}>
          <span className="fl">{r.label}{!r.is_active && <small> · inactive</small>}</span><small>{r.users} users</small></div>)}
      </div></div>
      {role && <div className="panel" aria-busy={saving}>
        <div className="ph">{role.label}{role.is_system && <Pill s="System" t="mu" />}<span className="fl" />
          <label className="row">Data scope <select className="in sm" value={role.scope} disabled={!can} onChange={e => commit(granted, e.target.value, 'Scope updated')}>
            {m.scopes.map(s => <option key={s.v} value={s.v}>{s.l}</option>)}{!m.scopes.some(s => s.v === role.scope) && <option value={role.scope}>{role.scope}</option>}</select></label></div>
        <div className="tw"><table className="t pmx"><thead><tr><th>Module</th>{m.acts.map(a => <th key={a.a} className="c">{a.l}</th>)}<th className="c">All</th><th>More</th></tr></thead>
          <tbody>{m.modules.map(mod => {
            const ids = allPermIds(mod)
            const every = ids.length > 0 && ids.every(id => granted.has(id))
            return <tr key={mod.key}><td>{mod.label}</td>
              {m.acts.map(a => { const p = mod.acts[a.a]; return <td key={a.a} className={p ? 'c' : 'na'}>{p
                ? <input type="checkbox" checked={granted.has(p.id)} disabled={!can} title={p.d || p.key} aria-label={`${mod.label} · ${a.l}`} onChange={e => toggle(p.id, e.target.checked)} />
                : '–'}</td> })}
              <td className="c all"><input type="checkbox" checked={every} disabled={!can || !ids.length} aria-label={`${mod.label} · All`} onChange={e => toggleAll(mod, e.target.checked)} /></td>
              <td>{mod.more.length ? <span className="more">{mod.more.map(p => <label key={p.id} title={p.d || p.key}><input type="checkbox" checked={granted.has(p.id)} disabled={!can} onChange={e => toggle(p.id, e.target.checked)} />{p.a || p.key.split('.').pop()}</label>)}</span> : <span className="mu">—</span>}</td>
            </tr>
          })}</tbody></table></div>
        <div className="pb"><small>Field-level security and record-sharing rules can be added per module from the other tabs. Changes save immediately and apply at the next request.</small></div>
      </div>}
    </div>
    {newRole && <NewRoleModal roles={m.roles} from={newRole.clone ? role : null} onClose={() => setNewRole(null)} onDone={async (id, fromId) => {
      setNewRole(null)
      try {
        if (fromId) { const src = m.roles.find(r => r.id === fromId); await admin360Api.setPermissions(id, m.grants[String(fromId)] || [], m.modules.map(x => ({ module: x.key, data_scope: src?.scope || 'own' }))) }
        await load(); setSel(id); success(newRole.clone ? 'Role cloned' : 'Role created')
      } catch (e) { error(errMsg(e, 'Role created, but permissions could not be copied')); load() }
    }} />}
  </>
}

function NewRoleModal({ roles, from, onClose, onDone }: { roles: MatrixRole[]; from: MatrixRole | null; onClose: () => void; onDone: (id: number, fromId: number | null) => void }) {
  const { error } = useToast()
  const [name, setName] = useState(from ? `${from.label} (copy)` : '')
  const [src, setSrc] = useState<string>(from ? String(from.id) : (roles[0] ? String(roles[0].id) : ''))
  const [desc, setDesc] = useState('')
  const vals = { name, src, desc }
  const v = useModalValidation(vals, () => ({
    name: { label: 'Role name', rule: 'name', required: true, min: 2, max: 100 },
    desc: { label: 'Description', rule: 'text', max: 500 },
  }), (x): Record<string, string> => {
    const n = x.name.trim().toLowerCase()
    // a role name made only of symbols has no usable key; an existing label is a duplicate
    if (n && !/[a-z0-9]/.test(n)) return { name: 'Role name must contain at least one letter or number.' }
    if (n && roles.some(r => r.label.trim().toLowerCase() === n)) return { name: `A role named "${x.name.trim()}" already exists. Please use a different name.` }
    return {}
  }, { name: 'nr-name', src: 'nr-src', desc: 'nr-desc' })
  const save = async () => {
    if (!v.submit()) return
    const n = name.trim()
    try {
      const r = await admin360Api.createRole({ name: n.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''), display_name: n, level: 10, description: desc.trim() || undefined })
      onDone(r.id, src ? Number(src) : null)
    } catch (e) { if (!v.server(e, { display_name: 'name', description: 'desc' })) error(errMsg(e)) }
  }
  return <Modal title={from ? 'Clone role' : 'New role'} width={420} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={save}>{from ? 'Clone role' : 'Create role'}</button></>}>
    <label className="lb">Role name</label><input id="nr-name" className={`in ${v.bad('name') ? 'err' : ''}`} value={name} {...v.aria('name')} onChange={e => { setName(e.target.value); v.change({ ...vals, name: e.target.value }, 'name') }} autoFocus /><FieldError id="nr-name" msg={v.errors.name} />
    <label className="lb mt">Start from</label><select id="nr-src" className="in" value={src} onChange={e => setSrc(e.target.value)}><option value="">— blank —</option>{roles.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
    <label className="lb mt">Description</label><input id="nr-desc" className={`in ${v.bad('desc') ? 'err' : ''}`} value={desc} {...v.aria('desc')} onChange={e => { setDesc(e.target.value); v.change({ ...vals, desc: e.target.value }, 'desc') }} /><FieldError id="nr-desc" msg={v.errors.desc} />
  </Modal>
}

/* ───────────── Sharing rules ───────────── */
function SharingTab() {
  const { success, error } = useToast()
  const [data, setData] = useState<{ items: SharingRule[]; objects: string[] } | null>(null)
  const [m, setM] = useState<Matrix | null>(null)
  const [edit, setEdit] = useState<SharingRule | 'new' | null>(null)
  const [del, setDel] = useState<SharingRule | null>(null)
  const load = useCallback(() => admin360Api.sharingRules().then(setData).catch(e => error(errMsg(e, 'Could not load sharing rules'))), [error])
  useEffect(() => { load(); admin360Api.matrix().then(setM).catch(() => undefined) }, [load])
  const can = !!m?.can.manage
  return <>
    <div className="pg"><h1>Record sharing rules</h1><span className="fl" />{can && <button type="button" className="btn p" onClick={() => setEdit('new')}><Ic n="plus" /> New rule</button>}</div>
    <Panel title="Rules" z>{data === null ? <div className="empty">Loading…</div> : <Tbl<SharingRule> cols={[
      { k: 'o', t: 'Object' }, { k: 'r', t: 'Rule', wr: true }, { k: 'w', t: 'Shared with' }, { k: 'a', t: 'Access', fn: x => <Pill s={x.a} t="ac" /> },
      { k: 'x', t: '', fn: x => can ? <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}><button type="button" className="btn s g" aria-label="Edit" onClick={() => setEdit(x)}><Ic n="edit" /></button>
        <button type="button" className="btn s g" aria-label="Delete" onClick={() => setDel(x)}><Ic n="trash" /></button></span> : null },
    ]} rows={data.items} empty="No sharing rules yet. Records follow the role data scope until a rule widens access." />}</Panel>
    {edit && data && m && <SharingModal rule={edit === 'new' ? null : edit} objects={data.objects} roles={m.roles} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); success(edit === 'new' ? 'Sharing rule created' : 'Sharing rule updated') }} />}
    {del && <Modal title="Remove sharing rule" width={420} onClose={() => setDel(null)} foot={<><span className="fl" /><button type="button" className="btn" onClick={() => setDel(null)}>Cancel</button>
      <button type="button" className="btn d" onClick={async () => { try { await admin360Api.deleteSharingRule(del.id); setDel(null); load(); success('Sharing rule removed') } catch (e) { error(errMsg(e)) } }}>Remove</button></>}>
      <p style={{ margin: 0 }}>Remove the rule “{del.r}”?</p></Modal>}
  </>
}

function SharingModal({ rule, objects, roles, onClose, onDone }: { rule: SharingRule | null; objects: string[]; roles: MatrixRole[]; onClose: () => void; onDone: () => void }) {
  const { error } = useToast()
  const [obj, setObj] = useState(rule?.o || objects[0] || 'Accounts'); const [text, setText] = useState(rule?.r || '')
  const [type, setType] = useState(rule?.type || 'role'); const [ref, setRef] = useState(rule?.ref || (roles[0]?.name || '')); const [access, setAccess] = useState(rule?.a || 'Read')
  const vals = { obj, text, type, ref, access }
  const v = useModalValidation(vals, x => ({
    obj: { label: 'an object', rule: 'select', required: true },
    text: { label: 'Rule', rule: 'text', required: true, min: 3, max: 300 },
    type: { label: 'who the records are shared with', rule: 'select', required: true },
    ref: x.type === 'role' ? { label: 'a role', rule: 'select', required: true } : x.type === 'team' ? { label: 'Team name', rule: 'name', required: true, min: 2, max: 120 } : undefined,
  }), () => ({}), { obj: 'sr-obj', text: 'sr-text', type: 'sr-type', ref: 'sr-ref', access: 'sr-access' })
  const save = async () => {
    if (!v.submit()) return
    try { await admin360Api.saveSharingRule({ object: obj, rule: text.trim(), shared_with_type: type, shared_with_ref: type === 'role' || type === 'team' ? ref.trim() : '', access }, rule?.id); onDone() }
    catch (e) { if (!v.server(e, { object: 'obj', rule: 'text', shared_with_type: 'type', shared_with_ref: 'ref' })) error(errMsg(e)) }
  }
  return <Modal title={rule ? 'Edit sharing rule' : 'New sharing rule'} width={540} onClose={onClose} foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" onClick={save}>{rule ? 'Save' : 'Create rule'}</button></>}>
    <div className="fg">
      <div><label>Object</label><select id="sr-obj" className={`in ${v.bad('obj') ? 'err' : ''}`} value={obj} onChange={e => { setObj(e.target.value); v.change({ ...vals, obj: e.target.value }, 'obj') }}>{objects.map(o => <option key={o}>{o}</option>)}</select><FieldError id="sr-obj" msg={v.errors.obj} /></div>
      <div><label>Access</label><select id="sr-access" className={`in ${v.bad('access') ? 'err' : ''}`} value={access} onChange={e => { setAccess(e.target.value); v.change({ ...vals, access: e.target.value }, 'access') }}><option>Read</option><option>Read / Write</option></select><FieldError id="sr-access" msg={v.errors.access} /></div>
      <div className="f1"><label>Rule</label><input id="sr-text" className={`in ${v.bad('text') ? 'err' : ''}`} placeholder="e.g. Bid Cell can edit every bid" value={text} {...v.aria('text')} onChange={e => { setText(e.target.value); v.change({ ...vals, text: e.target.value }, 'text') }} autoFocus /><FieldError id="sr-text" msg={v.errors.text} /></div>
      <div><label>Shared with</label><select id="sr-type" className={`in ${v.bad('type') ? 'err' : ''}`} value={type} onChange={e => { setType(e.target.value); v.change({ ...vals, type: e.target.value }, 'type') }}><option value="role">Role</option><option value="team">Team</option><option value="hierarchy">Hierarchy (managers)</option><option value="everyone">Everyone</option></select><FieldError id="sr-type" msg={v.errors.type} /></div>
      {type === 'role' && <div><label>Role</label><select id="sr-ref" className={`in ${v.bad('ref') ? 'err' : ''}`} value={ref} {...v.aria('ref')} onChange={e => { setRef(e.target.value); v.change({ ...vals, ref: e.target.value }, 'ref') }}>{roles.map(r => <option key={r.id} value={r.name}>{r.label}</option>)}</select><FieldError id="sr-ref" msg={v.errors.ref} /></div>}
      {type === 'team' && <div><label>Team name</label><input id="sr-ref" className={`in ${v.bad('ref') ? 'err' : ''}`} value={ref} {...v.aria('ref')} onChange={e => { setRef(e.target.value); v.change({ ...vals, ref: e.target.value }, 'ref') }} /><FieldError id="sr-ref" msg={v.errors.ref} /></div>}
    </div>
  </Modal>
}

/* ───────────── Field-level security ───────────── */
function FieldSecurityTab() {
  const { success, error } = useToast()
  const [mod, setMod] = useState('tenders')
  const [d, setD] = useState<FieldSecurity | null>(null)
  const [m, setM] = useState<Matrix | null>(null)
  useEffect(() => { admin360Api.matrix().then(setM).catch(() => undefined) }, [])
  useEffect(() => { setD(null); admin360Api.fieldSecurity(mod).then(setD).catch(e => error(errMsg(e, 'Could not load field security'))) }, [mod, error])
  const can = !!m?.can.manage
  const cell = (fk: string, rid: number) => d?.cells[fk]?.[String(rid)] || 'Edit'
  const set = async (fk: string, rid: number, access: string) => {
    if (!d) return
    const prev = cell(fk, rid)
    setD(x => x ? { ...x, cells: { ...x.cells, [fk]: { ...(x.cells[fk] || {}), [String(rid)]: access } } } : x)
    try { await admin360Api.setFieldSecurity({ module: d.module, field_key: fk, role_id: rid, access }); success(`Saved · ${d.fields.find(f => f.k === fk)?.l || fk}`) }
    catch (e) { error(errMsg(e, 'Could not save')); setD(x => x ? { ...x, cells: { ...x.cells, [fk]: { ...(x.cells[fk] || {}), [String(rid)]: prev } } } : x) }
  }
  const mods = d?.modules || [{ k: 'tenders', l: 'Bids & Tenders' }]
  return <>
    <div className="pg"><h1>Field-level security</h1><span className="fl" />
      <select className="in" style={{ width: 200 }} value={mod} aria-label="Module" onChange={e => setMod(e.target.value)}>{mods.map(x => <option key={x.k} value={x.k}>{x.l}</option>)}</select></div>
    <Panel title="Field visibility by role" z>{!d ? <div className="empty">Loading…</div> : <div className="tw fit"><table className="t fls">
      <thead><tr><th>Field</th>{d.roles.map(r => <th key={r.id} className="c">{r.label}</th>)}</tr></thead>
      <tbody>{d.fields.map(f => <tr key={f.k}><td>{f.l}{f.custom && <small className="mu"> · custom</small>}</td>
        {d.roles.map(r => { const v = cell(f.k, r.id); return <td key={r.id} className="c"><select className={`in sm ${v === 'Hidden' ? 'tbad' : ''}`} value={v} disabled={!can} aria-label={`${f.l} · ${r.label}`} onChange={e => set(f.k, r.id, e.target.value)}>
          {d.levels.map(l => <option key={l}>{l}</option>)}</select></td> })}</tr>)}</tbody></table></div>}</Panel>
  </>
}
