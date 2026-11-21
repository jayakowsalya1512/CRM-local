import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download, Search } from 'lucide-react'
import { platformApi, type ControlCategory, type ControlDef, type ControlValue, type ControlValues, type ControlStatus, type PlatformTenant } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Ic, Empty, Loading, Note, Panel, Pill, Switch, downloadBlob, errMsg, inputCls, inputStyle } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

const STATUS_PILL: Partial<Record<ControlStatus, [string, 'ok' | 'mu' | 'ba']>> = { live: ['Live', 'ok'], fixed: ['Fixed', 'mu'], unsupported: ['Not supported', 'ba'] }
const count = (cats: ControlCategory[]) => cats.reduce((a, s) => a + s.groups.reduce((b, g) => b + g.controls.length, 0), 0)
const controlsOf = (s: ControlCategory) => s.groups.flatMap(g => g.controls)

/** Schema + values for one editing scope (platform defaults, or one tenant's overrides). */
export function useControls(tenantId: number | null) {
  const [schema, setSchema] = useState<ControlCategory[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, string>>({})
  const [values, setValues] = useState<ControlValues | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  useEffect(() => { platformApi.controlSchema().then(r => { setSchema(r.data.categories); setStatuses(r.data.statuses) }).catch(err => setError(errMsg(err, 'Unable to load the control schema'))) }, [])
  const load = useCallback(async () => {
    const mine = ++seq.current
    try { const { data } = await platformApi.controlValues(tenantId); if (mine === seq.current) { setValues(data); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Unable to load control values')) }
  }, [tenantId])
  useEffect(() => { setValues(null); load() }, [load])
  const apply = (data: ControlValues) => { seq.current++; setValues(data) }
  return { schema, statuses, values, error, load, apply, tenantId }
}
type Ctl = ReturnType<typeof useControls>

// The prototype's change event: selects and switches save at once, number and text inputs when they lose focus.
function ControlInput({ c, value, disabled, onSave }: { c: ControlDef; value: ControlValue; disabled: boolean; onSave: (v: ControlValue) => void }) {
  const [draft, setDraft] = useState(String(value ?? ''))
  useEffect(() => setDraft(String(value ?? '')), [value])
  if (c.type === 'sw') return <Switch on={!!value} disabled={disabled} label={c.label} onChange={onSave} />
  if (c.type === 'sel') {
    const options = c.options.includes(String(value)) ? c.options : [String(value), ...c.options]
    return <select className={`${inputCls} !w-[240px] shrink-0`} style={inputStyle} disabled={disabled} value={String(value)} onChange={e => onSave(e.target.value)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  }
  const commit = () => {
    if (draft === String(value ?? '')) return
    if (c.type === 'num') { const n = Number(draft); if (draft.trim() === '' || Number.isNaN(n)) { setDraft(String(value)); return } onSave(n) } else onSave(draft)
  }
  return <input className={`${inputCls} shrink-0 ${c.type === 'num' ? '!w-[110px]' : '!w-[240px]'}`} style={inputStyle} disabled={disabled} type={c.type === 'num' ? 'number' : 'text'}
    step="any" value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
}

function ControlRow({ c, ctl, canManage, section, onSave, onReset }: { c: ControlDef; ctl: Ctl; canManage: boolean; section?: string; onSave: (c: ControlDef, v: ControlValue) => void; onReset: (c: ControlDef) => void }) {
  const v = ctl.values!
  const tm = !!ctl.tenantId
  const overridden = tm && !!v.overrides && c.key in v.overrides
  const value = overridden ? v.overrides![c.key] : v.platform[c.key]
  const changed = tm ? overridden : value !== c.default
  const locked = c.status === 'fixed' || c.status === 'unsupported' || (tm && c.platform_only)
  const pill = STATUS_PILL[c.status]
  const why = c.status === 'unsupported' || c.status === 'fixed' ? c.note : tm && c.platform_only ? 'Platform-wide setting – not overridable per tenant' : c.status === 'live' ? c.note : null
  return <div className="flex min-h-[38px] items-center gap-3 border-b px-2.5 py-1.5 text-[13px] last:border-b-0" style={{ borderColor: C.ln2 }}>
    <div className="min-w-0 flex-1">
      <b className="font-semibold" title={c.label !== c.prototype_label ? `Prototype: ${c.prototype_label}` : undefined}>{c.label}</b>
      {changed ? <> <Pill t={tm ? 'wa' : 'ac'}>{tm ? 'Tenant override' : 'Changed'}</Pill></> : tm ? <> <small style={{ color: C.mu }}>inherited</small></> : null}
      {pill && <> <Pill t={pill[1]} title={c.note ?? undefined}>{pill[0]}</Pill></>}
      {tm && c.platform_only && !pill && <> <Pill t="mu">Platform-wide</Pill></>}
      {section && <><br /><small style={{ color: C.mu }}>{section}</small></>}
      {why && <><br /><small style={{ color: C.mu }}>{why}</small></>}
    </div>
    <ControlInput c={c} value={value} disabled={!canManage || locked} onSave={next => onSave(c, next)} />
    <button type="button" className="w-11 shrink-0 text-right text-[13px]" style={{ color: C.ac, visibility: changed && canManage && !locked ? 'visible' : 'hidden' }} onClick={() => onReset(c)}>Reset</button>
  </div>
}

/** Prototype ctlLayout: category navigation, search and the selected category's grouped controls. */
export function ControlLayout({ ctl, canManage }: { ctl: Ctl; canManage: boolean }) {
  const { success, error: showError, info } = useToast()
  const [sec, setSec] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [confirmSec, setConfirmSec] = useState<ControlCategory | null>(null)
  const [busy, setBusy] = useState(false)
  const { schema, values, tenantId } = ctl
  const tm = !!tenantId
  if (ctl.error && !values) return <Note>{ctl.error}</Note>
  if (!schema || !values) return <Loading />
  const current = schema.find(s => s.id === sec) ?? schema[0]
  const isChanged = (c: ControlDef) => tm ? !!values.overrides && c.key in values.overrides : values.platform[c.key] !== c.default

  const save = async (c: ControlDef, v: ControlValue) => {
    try {
      const res = await platformApi.setControl(c.key, v, tenantId)
      if (res.status === 202) { info('Sent for four-eyes approval'); await ctl.load(); return }
      ctl.apply(res.data); success('Saved')
    } catch (err) { showError(errMsg(err, 'Unable to save')); await ctl.load() }
  }
  const reset = async (keys: string[], msg?: string) => {
    try {
      const res = await platformApi.resetControls(keys, tenantId)
      if (res.status === 202) { info('Sent for four-eyes approval'); await ctl.load(); return }
      ctl.apply(res.data); if (msg) success(msg)
    } catch (err) { showError(errMsg(err, 'Unable to reset')); await ctl.load() }
  }
  const query = q.trim().toLowerCase()
  const found = query ? schema.flatMap(s => s.groups.flatMap(g => g.controls.filter(c => `${c.label} ${c.prototype_label} ${c.key} ${g.name} ${s.name}`.toLowerCase().includes(query)).map(c => ({ c, path: `${s.name} › ${g.name}` })))) : []
  const row = (c: ControlDef, path?: string) => <ControlRow key={c.key} c={c} ctl={ctl} canManage={canManage} section={path} onSave={save} onReset={x => reset([x.key])} />

  return <div className="grid items-start gap-2 lg:grid-cols-[230px_minmax(0,1fr)]">
    <div className="min-w-0 rounded-md border" style={{ background: C.sf, borderColor: C.ln }}>
      <div className="flex min-h-[32px] items-center gap-2 border-b px-2.5 py-1.5 text-sm font-semibold" style={{ background: C.hd, borderColor: C.ln }}>{tm ? 'Overrides' : 'Categories'}<span className="flex-1" /><small className="text-xs font-normal" style={{ color: C.mu }}>{schema.length}</small></div>
      <div className="max-h-[70vh] overflow-auto">{schema.map(s => {
        const on = s.id === current.id && !query
        return <div key={s.id} role="button" tabIndex={0} onClick={() => { setSec(s.id); setQ('') }} onKeyDown={e => { if (e.key === 'Enter') { setSec(s.id); setQ('') } }}
          className="flex cursor-pointer items-center gap-2 border-b py-[7px] pr-2.5 text-[13px] hover:bg-[var(--bw-hd)]"
          style={{ borderColor: C.ln2, ...(on ? { background: 'color-mix(in srgb, var(--bw-ac) 10%, var(--bw-sf))', borderLeft: `3px solid ${C.ac}`, paddingLeft: 7, fontWeight: 500 } : { paddingLeft: 10 }) }}>
          <Ic n={s.icon} style={{ color: on ? C.ac : C.mu }} /><span className="min-w-0 flex-1">{s.name}</span><small className="text-xs" style={{ color: C.mu }}>{controlsOf(s).length}</small>
        </div>
      })}</div>
    </div>
    <div className="min-w-0">
      <div className="relative mb-2">
        <input className={`${inputCls} !pl-[26px]`} style={inputStyle} placeholder={`Search ${count(schema)} controls by name, key or category…`} value={q} onChange={e => setQ(e.target.value)} />
        <Search size={14} className="absolute left-[7px] top-[7px]" style={{ color: C.mu }} />
      </div>
      {query ? <>
        <div className="mb-2 text-[13px]"><b>{found.length}</b> controls match “{q.trim()}”</div>
        <Panel title="Search results" flush>{found.length ? found.map(f => row(f.c, f.path)) : <Empty>No controls match</Empty>}</Panel>
      </> : <>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold">{current.name} <small className="text-xs font-normal" style={{ color: C.mu }}>{controlsOf(current).length} controls · {controlsOf(current).filter(isChanged).length} {tm ? 'overridden' : 'changed'}</small></h2>
          {canManage && <Btn s onClick={() => setConfirmSec(current)}>Reset section to defaults</Btn>}
        </div>
        {current.groups.map(g => <Panel key={g.name} className="mb-2" flush title={<>{g.name} <small className="text-xs font-normal" style={{ color: C.mu }}>{g.controls.length}</small></>}>{g.controls.map(c => row(c))}</Panel>)}
      </>}
    </div>
    {confirmSec && <BwModal title="Reset section" onClose={() => setConfirmSec(null)} width={420} foot={<>
      <Btn onClick={() => setConfirmSec(null)}>Cancel</Btn>
      <Btn p disabled={busy} onClick={async () => { setBusy(true); await reset(controlsOf(confirmSec).filter(c => c.status !== 'fixed' && c.status !== 'unsupported').map(c => c.key), 'Section reset'); setBusy(false); setConfirmSec(null) }}>Reset</Btn>
    </>}><p className="text-[13px]">Reset every control in “{confirmSec.name}” to its default?</p></BwModal>}
  </div>
}

export default function PlatformControlCenterPage() {
  const [params, setParams] = useSearchParams()
  const { can } = usePlatformAccess()
  const canManage = can('settings', 'manage')
  const { success, error: showError } = useToast()
  const tenantId = Number(params.get('tenant')) || null
  const ctl = useControls(tenantId)
  const [tenants, setTenants] = useState<PlatformTenant[]>([])
  useEffect(() => { platformApi.listTenants().then(r => setTenants(r.data)).catch(() => setTenants([])) }, [])
  const tenantName = ctl.values?.tenant?.name ?? tenants.find(t => t.id === tenantId)?.name ?? ''

  const changed = useMemo(() => {
    if (!ctl.schema || !ctl.values) return 0
    const platform = ctl.schema.flatMap(controlsOf).filter(c => ctl.values!.platform[c.key] !== c.default).length
    return platform + Object.keys(ctl.values.overrides ?? {}).length
  }, [ctl.schema, ctl.values])

  const exportConfig = async () => {
    try {
      const res = await platformApi.exportControls(tenantId)
      const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] ?? '')?.[1] ?? 'control-config.json'
      downloadBlob(res.data, name)
      success('Configuration snapshot exported as JSON')
    } catch (err) { showError(errMsg(err, 'Export failed')) }
  }

  return <div>
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Control</div><h1 className="text-xl font-semibold">Control center</h1></div>
      {ctl.schema && <span className="text-xs" style={{ color: C.mu }}>{count(ctl.schema)} configurable controls · {ctl.schema.length} categories · {changed} changed</span>}
      <span className="flex-1" />
      <label className="flex items-center gap-2 text-[13px]">Editing
        <select className={`${inputCls} !w-[260px]`} style={inputStyle} value={tenantId ?? 'plat'} onChange={e => setParams(e.target.value === 'plat' ? {} : { tenant: e.target.value })}>
          <option value="plat">Platform defaults (all tenants)</option>
          {tenantId && !tenants.some(t => t.id === tenantId) && <option value={tenantId}>Override for {tenantName}</option>}
          {tenants.map(t => <option key={t.id} value={t.id}>Override for {t.name}</option>)}
        </select>
      </label>
      <Btn onClick={exportConfig}><Download size={14} /> Export config</Btn>
    </div>
    <Note info className="mb-2">{tenantId
      ? <>You are editing <b>tenant-level overrides</b> for {tenantName}. Anything not overridden inherits the platform default.</>
      : <>These are the <b>platform defaults</b> every tenant inherits unless overridden on the tenant page.</>}</Note>
    <Note className="mb-2">Controls marked <b>Live</b> are applied by the platform. <b>Fixed</b> controls are set by the self-hosted MariaDB architecture (database per tenant) and <b>Not supported</b> controls have no self-hosted equivalent; both are read-only. All other controls are saved, inherited by tenants and exported, but not yet enforced.</Note>
    <ControlLayout ctl={ctl} canManage={canManage} />
  </div>
}
