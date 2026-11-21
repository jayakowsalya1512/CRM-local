import { Fragment, useCallback, useEffect, useState } from 'react'
import { platformApi, type EntitlementState, type EntitlementsOverview, type FeatureFlag } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Note, Panel, Pill, errMsg, inputCls, inputStyle } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype Plans & Entitlements page (P.flags): module entitlement by plan, and feature flags.
// Rows are every tenant sidebar module (same names, sections and order as the tenant app) plus custom catalog modules,
// columns the plans; a tick covers the module and its sub-modules. A module that ships with another one follows it.
function Tick({ state, title, disabled, onChange }: { state: EntitlementState; title: string; disabled: boolean; onChange: (v: boolean) => void }) {
  return <input type="checkbox" title={title} disabled={disabled} checked={state === 'on' || state === 'always'}
    ref={el => { if (el) el.indeterminate = state === 'partial' }} onChange={e => onChange(e.target.checked)} style={{ accentColor: 'var(--bw-ac)' }} />
}

function FlagRow({ flag, canEdit, onSaved }: { flag: FeatureFlag; canEdit: boolean; onSaved: (f: FeatureFlag) => void }) {
  const { error: showError } = useToast()
  const [value, setValue] = useState(flag.rollout_percent)
  useEffect(() => setValue(flag.rollout_percent), [flag.rollout_percent])
  const commit = async () => {
    if (value === flag.rollout_percent) return
    try { const { data } = await platformApi.setFlagRollout(flag.key, value); onSaved(data) }
    catch (err) { setValue(flag.rollout_percent); showError(errMsg(err, 'Unable to change the rollout')) }
  }
  return <div className="border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }} title={flag.description || undefined}>
    <div className="flex items-center gap-2"><span className="flex-1">{flag.name}</span>
      <Pill t="ac" title={`${flag.tenants_on} of ${flag.tenants} tenant(s) in the rollout`}>{value}%</Pill></div>
    <input type="range" min={0} max={100} value={value} disabled={!canEdit} className="w-full" style={{ accentColor: 'var(--bw-ac)' }}
      onChange={e => setValue(Number(e.target.value))} onPointerUp={() => void commit()} onKeyUp={() => void commit()} />
  </div>
}

type Plans = EntitlementsOverview['plans']
const slugKey = (v: string) => v.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100)

/** New module requested by a company: a Services catalog entry, optionally included in plans right away. */
function CreateModuleDialog({ plans, sections, onClose, onCreated }: { plans: Plans; sections: string[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const { success, error: showError } = useToast()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [category, setCategory] = useState('Custom modules')
  const [description, setDescription] = useState('')
  const [planIds, setPlanIds] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const effectiveKey = keyTouched ? key : slugKey(name)
  const valid = !!name.trim() && /^[a-z0-9_]{1,100}$/.test(effectiveKey)

  const save = async () => {
    if (!valid) return
    setSaving(true)
    try {
      await platformApi.createService({ name: name.trim(), key: effectiveKey, module: category.trim() || 'Custom modules', description: description.trim() || undefined })
      const picked = plans.filter(p => planIds.has(p.id))
      const res = await Promise.allSettled(picked.map(p => platformApi.setPlanModule(p.id, effectiveKey, true)))
      const failed = picked.filter((_, i) => res[i].status === 'rejected').map(p => p.name)
      success(`${name.trim()} created${picked.length ? ` · included in ${picked.length - failed.length} plan(s)` : ''}`)
      if (failed.length) showError(`Not added to ${failed.join(', ')} – tick it in the grid to retry`)
      await onCreated()
      onClose()
    } catch (err) { showError(errMsg(err, 'Unable to create the module')) } finally { setSaving(false) }
  }

  return <BwModal title="Create module" onClose={onClose} width={520}
    foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={!valid || saving} onClick={() => void save()}>{saving ? 'Creating…' : 'Create module'}</Btn></>}>
    <div className="space-y-2.5 text-[13px]">
      <Field label="Module name" req><input className={inputCls} style={inputStyle} value={name} maxLength={200} autoFocus placeholder="e.g. Service Contracts" onChange={e => setName(e.target.value)} /></Field>
      <Field label="Key" req><input className={inputCls} style={inputStyle} value={effectiveKey} maxLength={100} placeholder="service_contracts"
        onChange={e => { setKeyTouched(true); setKey(e.target.value.toLowerCase()) }} />
        <small style={{ color: C.mu }}>Lowercase letters, numbers and underscores. Used as the entitlement key – it can't be changed later.</small></Field>
      <Field label="Category"><input className={inputCls} style={inputStyle} value={category} maxLength={100} list="bw-module-sections" onChange={e => setCategory(e.target.value)} />
        <datalist id="bw-module-sections">{sections.map(x => <option key={x} value={x} />)}</datalist></Field>
      <Field label="Description"><textarea className={inputCls} style={inputStyle} rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="What the company asked for" /></Field>
      {!!plans.length && <Field label="Include in plans">
        <div className="flex flex-wrap gap-x-4 gap-y-1">{plans.map(p => <label key={p.id} className="flex items-center gap-1.5">
          <input type="checkbox" checked={planIds.has(p.id)} style={{ accentColor: 'var(--bw-ac)' }}
            onChange={e => setPlanIds(prev => { const n = new Set(prev); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n })} />{p.name}</label>)}</div>
        <small style={{ color: C.mu }}>Tenants on these plans get the entitlement now; you can change it in the grid at any time.</small></Field>}
    </div>
  </BwModal>
}

export default function PlatformEntitlementsPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<EntitlementsOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.entitlements(); setData(next); setError('') }
    catch (err) { setError(errMsg(err, 'Plans & entitlements unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const canEdit = can('feature_matrix', 'manage') && !!data?.all_scope
  const canCreate = can('services', 'manage') && can('feature_matrix', 'view') && !!data?.all_scope
  const [creating, setCreating] = useState(false)

  const toggle = async (planId: number, planName: string, key: string, name: string, enabled: boolean) => {
    setBusy(`${planId}:${key}`)
    try {
      const { data: r } = await platformApi.setPlanModule(planId, key, enabled)
      const reach = r.applied.length ? ` · applied to ${r.applied.map(t => t.name).join(', ')}` : ''
      success(`${name} ${enabled ? 'added to' : 'removed from'} ${planName}${reach}`)
      if (r.failed.length) showError(`Not applied to ${r.failed.map(t => t.name).join(', ')} – tenant database unreachable`)
      await load()
    } catch (err) { showError(errMsg(err, 'Unable to change the entitlement')) } finally { setBusy('') }
  }

  const cellTitle = (m: EntitlementsOverview['modules'][number], cell: { state: EntitlementState; on: number; of: number }) =>
    cell.state === 'always' ? 'Always included in every workspace'
      : m.bundled_with ? `Ships with ${m.bundled_with_name || m.bundled_with} – change that module to include or remove it`
      : cell.state === 'partial' ? `${cell.on} of ${cell.of} included${m.sub_modules.length ? ` (sub-modules: ${m.sub_modules.join(', ')})` : ''} – tick to include all`
        : m.sub_modules.length ? `Includes ${m.sub_modules.join(', ')}` : m.name

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div className="flex-1"><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Business</div><h1 className="text-xl font-semibold">Modules &amp; feature flags</h1></div>
      {data && <Btn p disabled={!canCreate} onClick={() => setCreating(true)}
        title={canCreate ? 'Add a module a company has requested' : 'Needs Services manage permission and all-tenant scope'}>+ Create module</Btn>}
    </div>
    {creating && data && <CreateModuleDialog plans={data.plans} sections={[...new Set(data.modules.map(m => m.section_label))]} onClose={() => setCreating(false)} onCreated={load} />}
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {data && !data.all_scope && <Note info className="mb-2">Plan entitlements and rollouts apply to every tenant – changing them needs all-tenant scope.</Note>}

    {!data ? <Panel title="Module entitlement by plan"><Empty>{error || 'Loading…'}</Empty></Panel> : <div className="grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title={<>Module entitlement by plan <small className="font-normal" style={{ color: C.mu }}>· {data.modules.length} modules</small></>} flush>
        {!data.plans.length ? <Empty>No plans yet.</Empty> : !data.modules.length ? <Empty>The Services catalog has no modules.</Empty> :
          <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 160 + data.plans.length * 96 }}>
            <thead><tr><th>Module</th>{data.plans.map(p => <th key={p.id} className="text-center" title={`${p.tenants} tenant(s)${p.is_active ? '' : ' · plan inactive'}`}
              style={p.is_active ? undefined : { color: C.mu }}>{p.name}</th>)}</tr></thead>
            <tbody>{data.modules.map((m, i) => <Fragment key={m.key}>
              {(i === 0 || data.modules[i - 1].section !== m.section) && <tr><td colSpan={data.plans.length + 1}
                className="!pt-3 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: C.mu }}>{m.section_label}</td></tr>}
              <tr>
                <td>{m.name}
                  {m.bundled_with && <> <Pill t="mu" title={`Switched on together with ${m.bundled_with_name || m.bundled_with}`}>with {m.bundled_with_name || m.bundled_with}</Pill></>}
                  {m.custom && <> <Pill t="ac" title="Created in Platform Administration">Custom</Pill></>}
                  {!m.is_active && <> <Pill t="mu" title="Deactivated in the Services catalog">Inactive</Pill></>}</td>
                {data.plans.map(p => { const cell = m.plans[String(p.id)]; return <td key={p.id} className="text-center">
                  <Tick state={cell.state} title={cellTitle(m, cell)} disabled={!canEdit || cell.state === 'always' || !!m.bundled_with || !!busy}
                    onChange={v => void toggle(p.id, p.name, m.key, m.name, v)} />
                </td> })}
              </tr>
            </Fragment>)}</tbody>
          </table></div>}
      </Panel>
      <Panel title="Feature flags" flush>
        {!data.flags.length ? <Empty>No feature flags are declared by this release.</Empty>
          : <div>{data.flags.map(f => <FlagRow key={f.key} flag={f} canEdit={canEdit}
            onSaved={next => { setData(d => d && { ...d, flags: d.flags.map(x => x.key === next.key ? next : x) }); success(`${next.name}: ${next.rollout_percent}% rollout`) }} />)}</div>}
      </Panel>
    </div>}
  </div>
}
