import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  isApprovalQueued, platformApi,
  type EntitlementModule, type HierarchyGroupRow, type HierarchyServer, type HierarchyTenantRow, type ParentVisibility, type PlatformPlan, type WorkflowRuleTemplate,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Ic, Kv, Note, PageHead, Pill, cap, errMsg, fd, inputCls, inputStyle, inr, num, statusTone, useKpiPopup } from '@/components/platform/bw'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

type Row = HierarchyTenantRow | HierarchyGroupRow
type View = 'Table' | 'Hierarchy'
type BulkKind = 'suspend' | 'plan' | 'workflow' | 'module' | 'announce' | 'move'

const INDUSTRIES = ['Power T&D', 'EPC & Civil', 'Defence Electronics', 'Medical Equipment', 'Rail Components', 'Water & Environment']
const PARENT_CAN_SEE = { full: 'Full data & workspace', reports: 'Consolidated reports only', none: 'None (fully isolated)' } as const
const gb = (m: number) => `${(m / 1024).toFixed(m >= 102.4 ? 1 : 2)} GB`
const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)

const typeText = (r: Row) => r.kind === 'group' ? 'Parent group' : r.parent_group_id ? 'Company' : 'Standalone'
// Prototype: pill(type, group ? 'ac' : 'mu')
export const typePill = (r: Row) => <Pill t={r.kind === 'group' ? 'ac' : 'mu'}>{typeText(r)}</Pill>
const healthBar = (v: number | null) => v == null ? <span style={{ color: C.mu }}>—</span>
  : <div className="flex items-center gap-1.5"><div className="h-1.5 flex-1 overflow-hidden rounded" style={{ background: C.ln2 }}><i className="block h-full rounded" style={{ width: `${v}%`, background: v < 70 ? C.wa : C.ok }} /></div><small className="w-6 text-right text-xs">{v}</small></div>

export function openWorkspace(r: HierarchyTenantRow) {
  const local = /^(localhost|127\.|\d+\.\d+\.\d+\.\d+$)/.test(window.location.hostname) || window.location.hostname.endsWith('.localhost')
  if (r.workspace_url && !local) { window.open(r.workspace_url, '_blank', 'noopener'); return }
  try { localStorage.setItem('last_tenant', r.slug) } catch { /* ignore */ }
  window.open('/login', '_blank', 'noopener')
}

// ─── Create wizard (prototype A.wizOpen) ────────────────────────────────────

const STEPS = ['1. Basics', '2. Hierarchy', '3. Plan & modules', '4. Workflow', '5. Review']
type ProvStatus = 'pending' | 'running' | 'done' | 'failed'
const PROVISIONING = ['Tenant record, MariaDB database, tables, modules & administrator', 'Plan & hierarchy settings', 'Workflow template', 'Admin invitation email']
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())

// Module picker rows come from Plans & Entitlements (GET /entitlements/modules): same names, sections and order as the
// entitlement grid and the tenant sidebar. A row covers all of its feature ids; bundled rows follow their parent module.
type ModState = 'on' | 'off' | 'partial' | 'always'
function moduleState(m: EntitlementModule, byKey: Map<string, EntitlementModule>, ids: Set<number>): ModState {
  if (m.always_on) return 'always'
  const src = m.bundled_with ? byKey.get(m.bundled_with) : m
  if (!src) return 'always'
  if (src !== m) return moduleState(src, byKey, ids)
  if (!src.feature_ids.length) return 'off'
  const on = src.feature_ids.filter(i => ids.has(i)).length
  return on === src.feature_ids.length ? 'on' : on ? 'partial' : 'off'
}
const switchable = (m: EntitlementModule) => !m.always_on && !m.bundled_with && m.feature_ids.length > 0
function useModuleCatalog(enabled = true) {
  const [mods, setMods] = useState<EntitlementModule[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!enabled) return
    platformApi.entitlementModules().then(({ data }) => { setMods(data); setErr('') }).catch(e => { setMods([]); setErr(errMsg(e, 'Module list unavailable')) })
  }, [enabled])
  const byKey = useMemo(() => new Map((mods || []).map(m => [m.key, m])), [mods])
  return { mods, byKey, err }
}

export function CreateWizard({ group, groups, tenants, plans, presetGroup, onClose, onCreated }: {
  group: boolean; groups: HierarchyGroupRow[]; tenants: HierarchyTenantRow[]; plans: PlatformPlan[]; presetGroup?: number | null
  onClose: () => void; onCreated: (path: string) => void
}) {
  const { success, error: showError } = useToast()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const catalog = useModuleCatalog(!group)
  const [rules, setRules] = useState<WorkflowRuleTemplate[] | null>(null)
  // Provisioning progress after "Create tenant"; the tenant id is kept so a failed step can be retried.
  const [prov, setProv] = useState<{ tenantId: number | null; status: ProvStatus[]; detail: string[] } | null>(null)
  const [w, setW] = useState({
    name: '', ind: INDUSTRIES[0], sub: '', col: '#0F6E8C', kind: presetGroup ? 'child' : 'standalone', parent: (presetGroup ?? groups[0]?.id ?? null) as number | null,
    vis: (groups.find(g => g.id === presetGroup)?.default_visibility || 'full') as ParentVisibility, inherit: true,
    plan: (group ? null : plans[0]?.id ?? null) as number | null, mods: new Set<number>(), template: '' as string, admin: '', email: '',
  })
  const set = <K extends keyof typeof w>(k: K, v: (typeof w)[K]) => setW(x => ({ ...x, [k]: v }))
  const plan = plans.find(p => p.id === w.plan)
  const enabledModules = (catalog.mods || []).filter(m => { const st = moduleState(m, catalog.byKey, w.mods); return st === 'on' || st === 'always' }).length
  const sections = useMemo(() => {
    const out: [string, EntitlementModule[]][] = []
    for (const m of catalog.mods || []) { const last = out[out.length - 1]; if (last && last[0] === m.section_label) last[1].push(m); else out.push([m.section_label, [m]]) }
    return out
  }, [catalog.mods])
  // Control center → Default plan for new tenants (new parent groups get the default visibility server-side)
  useEffect(() => {
    if (group) return
    platformApi.controlValues().then(({ data }) => {
      const defPlan = plans.find(x => x.name === data.platform.defPlan)
      if (defPlan) setW(x => ({ ...x, plan: defPlan.id }))
    }).catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (group || !w.plan) return
    platformApi.getPlanFeatures(w.plan).then(({ data }) => set('mods', new Set(data.feature_ids))).catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.plan, group])
  useEffect(() => {
    setRules(null)
    if (w.template) platformApi.tenantWorkflowTemplates(Number(w.template)).then(({ data }) => setRules(data)).catch(() => setRules([]))
  }, [w.template])
  const sub = slugify(w.sub || w.name)
  const next = () => {
    if (step === 0 && !w.name.trim()) return showError('Enter a name first')
    if (step === 0 && !sub) return showError('Enter a sub-domain')
    if (!group && step === 1 && w.kind === 'child' && !w.parent) return showError('Choose a parent group')
    if (!group && step === 2 && !w.plan) return showError('Choose a plan')
    if (!group && step === 3 && (!w.admin.trim() || !isEmail(w.email))) return showError('Enter the first admin’s name and a valid email')
    setStep(s => s + 1)
  }
  const create = async () => {
    setBusy(true)
    try {
      if (group) {
        const { data } = await platformApi.createTenantGroup({ name: w.name.trim(), slug: sub, industry: w.ind, color: w.col, plan_id: w.plan })
        success(`${w.name.trim()} created`); onCreated(`/platform/tenant-groups/${data.id}`); return
      }
      await provision(0, null)
    } catch (err) { showError(errMsg(err, 'Unable to create')) } finally { setBusy(false) }
  }
  // Runs the provisioning steps in order from `from`; stops at the first failure so it can be retried.
  const provision = async (from: number, existingId: number | null) => {
    const status: ProvStatus[] = PROVISIONING.map((_, i) => (i < from ? 'done' : 'pending'))
    const detail = prov?.detail.slice() ?? PROVISIONING.map(() => '')
    let tenantId = existingId
    const show = () => setProv({ tenantId, status: status.slice(), detail: detail.slice() })
    const steps: (() => Promise<string>)[] = [
      async () => {
        const { data } = await platformApi.wizardCreateTenant({ name: w.name.trim(), subdomain: sub, plan_id: w.plan, feature_ids: [...w.mods], admin_name: w.admin.trim(), admin_email: w.email.trim() })
        tenantId = data.id
        return `Database ${data.db_name} provisioned`
      },
      async () => {
        await platformApi.setTenantHierarchy(tenantId!, { industry: w.ind, color: w.col, ...(w.kind === 'child' && w.parent ? { parent_group_id: w.parent, parent_visibility: w.vis, inherit_parent_policies: w.inherit } : {}) })
        return w.kind === 'child' ? `Company under ${groups.find(g => g.id === w.parent)?.name}` : 'Standalone tenant'
      },
      async () => {
        if (!w.template) { await platformApi.recordBlankWorkflow(tenantId!); return 'Blank template' }
        const { data } = await platformApi.pushWorkflowTemplate(Number(w.template), [tenantId!])
        const r = data.results[0]
        if (r?.error) throw new Error(r.error)
        return `${r?.copied.length ?? 0} workflow(s) copied, ${r?.skipped.length ?? 0} skipped`
      },
      async () => (await platformApi.inviteTenantAdmin(tenantId!)).data.message,
    ]
    for (let i = from; i < steps.length; i++) {
      status[i] = 'running'; show()
      try { detail[i] = await steps[i](); status[i] = 'done'; show() }
      catch (err) { detail[i] = errMsg(err, (err as Error)?.message || 'Step failed'); status[i] = 'failed'; show(); return }
    }
    success(`${w.name.trim()} created`)
  }
  const portable = rules?.filter(r => r.portable) || []
  const radio = (k: 'standalone' | 'child', title: string, text: string) => <label className={`atile !flex !gap-2 !p-[9px] !text-[var(--bw-tx)] ${w.kind === k ? "on" : ""}`}>
    <input type="radio" checked={w.kind === k} onChange={() => set('kind', k)} /><span><b>{title}</b><br /><small style={{ color: C.mu }}>{text}</small></span></label>
  const body: ReactNode[] = [
    <div key="b" className="grid gap-2.5 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label={group ? 'Parent group name *' : 'Company / tenant name *'}><input className={inputCls} style={inputStyle} value={w.name} onChange={e => set('name', e.target.value)} autoFocus /></Field></div>
      <Field label="Industry"><select className={inputCls} style={inputStyle} value={w.ind} onChange={e => set('ind', e.target.value)}>{INDUSTRIES.map(i => <option key={i}>{i}</option>)}</select></Field>
      <Field label="Sub-domain"><input className={inputCls} style={inputStyle} value={w.sub} placeholder={slugify(w.name) || 'acme'} onChange={e => set('sub', e.target.value)} /></Field>
      <Field label="Brand colour"><input type="color" className={`${inputCls} !h-9 cursor-pointer p-1`} style={inputStyle} value={w.col} onChange={e => set('col', e.target.value)} /></Field>
    </div>,
    group ? <Note key="h" info>A parent group has no data of its own. Add companies to it after creation – the group will see them consolidated.</Note>
      : <div key="h" className="space-y-2.5">
        <div className="grid gap-2 sm:grid-cols-2">{radio('standalone', 'Standalone tenant', 'Independent company, no parent.')}{radio('child', 'Company under a parent group', 'Appears in the parent’s consolidated view and company switcher.')}</div>
        {w.kind === 'child' && (groups.length ? <div className="grid gap-2.5 sm:grid-cols-2">
          <Field label="Parent group"><select className={inputCls} style={inputStyle} value={w.parent ?? ''} onChange={e => { const g = groups.find(x => x.id === Number(e.target.value)); setW(x => ({ ...x, parent: Number(e.target.value), vis: g?.default_visibility || x.vis })) }}>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
          <Field label="Parent visibility"><select className={inputCls} style={inputStyle} value={w.vis} onChange={e => set('vis', e.target.value as ParentVisibility)}><option value="full">Full</option><option value="reports">Reports only</option><option value="none">None</option></select></Field>
          <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={w.inherit} onChange={e => set('inherit', e.target.checked)} /> Inherit parent’s masters, roles and approval policy</label>
        </div> : <Note>No parent groups exist yet – create one first with “New parent group”.</Note>)}
      </div>,
    group ? <div key="p" className="space-y-2.5"><p>Group plan applies to the consolidated view.</p><Field label="Group plan"><select className={inputCls} style={inputStyle} value={w.plan ?? ''} onChange={e => set('plan', e.target.value ? Number(e.target.value) : null)}><option value="">— None —</option>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field></div>
      : <div key="p" className="space-y-2.5">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Field label="Plan"><select className={inputCls} style={inputStyle} value={w.plan ?? ''} onChange={e => set('plan', Number(e.target.value))}>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Price"><input className={inputCls} style={inputStyle} disabled value={plan ? `${inr(plan.price_monthly)} / month` : '—'} /></Field>
        </div>
        <h3 className="font-semibold">Modules <small className="font-normal" style={{ color: C.mu }}>· {enabledModules} of {catalog.mods?.length ?? 0} enabled</small></h3>
        {catalog.err && <Note>{catalog.err}</Note>}
        <div className="max-h-56 overflow-auto rounded-lg border p-2 text-xs" style={{ borderColor: C.ln2 }}>
          {catalog.mods == null ? <small style={{ color: C.mu }}>Loading…</small> : sections.map(([label, rows]) => <div key={label} className="mb-1.5 last:mb-0">
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: C.mu }}>{label}</div>
            <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-3">{rows.map(m => { const st = moduleState(m, catalog.byKey, w.mods); return <label key={m.key}
              className="flex items-center gap-1.5 py-0.5 !text-[var(--bw-tx)]"
              title={m.always_on ? 'Always included in every workspace' : m.bundled_with ? `Ships with ${m.bundled_with_name || m.bundled_with}` : m.sub_modules.length ? `Includes ${m.sub_modules.join(', ')}` : m.name}>
              <input type="checkbox" disabled={!switchable(m)} checked={st === 'on' || st === 'always'} ref={el => { if (el) el.indeterminate = st === 'partial' }}
                onChange={e => { const n = new Set(w.mods); m.feature_ids.forEach(i => e.target.checked ? n.add(i) : n.delete(i)); set('mods', n) }} /> {m.name}</label> })}</div>
          </div>)}
        </div>
      </div>,
    group ? <p key="w" style={{ color: C.mu }}>Not applicable to a parent group.</p>
      : <div key="w" className="space-y-2.5">
        <Field label="Starting workflow template (tenant admin can edit later)"><select className={inputCls} style={inputStyle} value={w.template} onChange={e => set('template', e.target.value)}><option value="">Blank – no approval workflows</option>{tenants.map(t => <option key={t.id} value={t.id}>Copy approval workflows from {t.name}</option>)}</select></Field>
        {w.template && <div className="flex flex-wrap gap-[3px]">{rules == null ? <small style={{ color: C.mu }}>Loading…</small> : [...new Set(portable.map(r => `${r.module} · ${r.action}`))].map(s => <Pill key={s} t="mu">{s}</Pill>)}</div>}
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Field label="First admin – name"><input className={inputCls} style={inputStyle} value={w.admin} onChange={e => set('admin', e.target.value)} /></Field>
          <Field label="Admin email"><input type="email" className={inputCls} style={inputStyle} value={w.email} onChange={e => set('email', e.target.value)} /></Field>
        </div>
      </div>,
    <div key="r" className="space-y-2.5">
      <Kv rows={[['Name', w.name], ['Type', group ? 'Parent group' : w.kind === 'child' ? `Company under ${groups.find(g => g.id === w.parent)?.name || '—'}` : 'Standalone'], ['Plan', plan?.name || '—'],
        ['Modules enabled', group ? '—' : String(enabledModules)], ['Workflow', group ? '—' : w.template ? `Copy approval workflows from ${tenants.find(t => String(t.id) === w.template)?.name}` : 'Blank – no approval workflows'], ['Admin', group ? '—' : w.admin || '—']]} />
      <Note info className="mt-2.5">{group ? 'The group gets a consolidated view of the companies you attach.' : 'An invitation email will be sent to the admin. Data isolation: dedicated MariaDB database.'}</Note>
    </div>,
  ]
  if (prov) {
    const running = prov.status.includes('running'), failedAt = prov.status.indexOf('failed'), ready = prov.status.every(x => x === 'done')
    const icon = { pending: '○', running: '◌', done: '✓', failed: '✕' } as const
    const tone = { pending: C.mu, running: C.ac, done: C.ok, failed: C.ba }
    return <BwModal title="Create tenant" width={640} onClose={() => { if (!running) { if (prov.tenantId) onCreated(`/platform/tenants/${prov.tenantId}`); else onClose() } }} foot={<>
      {failedAt >= 0 && <Btn p onClick={() => void provision(failedAt, prov.tenantId)}>Retry</Btn>}
      {prov.tenantId && !running && <Btn p={ready} onClick={() => onCreated(`/platform/tenants/${prov.tenantId}`)}>Open tenant</Btn>}
      {!prov.tenantId && !running && <Btn onClick={onClose}>Close</Btn>}
    </>}>
      <div className="space-y-1.5">{PROVISIONING.map((label, i) => <div key={label} className="flex items-start gap-2 rounded-lg border px-3 py-2" style={{ borderColor: prov.status[i] === 'failed' ? C.ba : C.ln2 }}>
        <b className={prov.status[i] === 'running' ? 'animate-spin' : ''} style={{ color: tone[prov.status[i]], width: 14 }}>{icon[prov.status[i]]}</b>
        <span className="flex-1"><b>{label}</b>{prov.detail[i] && <><br /><small style={{ color: prov.status[i] === 'failed' ? C.ba : C.mu }}>{prov.detail[i]}</small></>}</span>
        <small style={{ color: tone[prov.status[i]] }}>{prov.status[i] === 'running' ? 'In progress' : cap(prov.status[i])}</small>
      </div>)}</div>
      <Note info={ready || failedAt < 0} className="mt-2.5">{ready ? 'Provisioning complete. The tenant continues through the remaining go-live steps in Onboarding & provisioning.'
        : failedAt === 0 ? 'Nothing was created – the tenant record and database are rolled back when provisioning fails.'
        : failedAt > 0 ? 'The tenant exists but is not ready. Fix the problem and retry this step.' : 'Provisioning in progress…'}</Note>
    </BwModal>
  }
  return <BwModal title={group ? 'Create parent group' : 'Create tenant'} width={640} onClose={onClose} foot={<>
    <Btn onClick={() => step ? setStep(step - 1) : onClose()}>{step ? 'Back' : 'Cancel'}</Btn>
    {step < 4 ? <Btn p onClick={next}>Continue</Btn> : <Btn p onClick={() => void create()} disabled={busy}>{busy ? 'Creating…' : group ? 'Create parent group' : 'Create tenant'}</Btn>}
  </>}>
    <div className="mb-3 flex flex-wrap gap-1">{STEPS.map((s, i) => <Pill key={s} t={i === step ? 'ac' : i < step ? 'ok' : 'mu'}>{s}</Pill>)}</div>
    {body[step]}
  </BwModal>
}

// ─── Bulk action modal ──────────────────────────────────────────────────────

function BulkModal({ kind, rows, tenants, plans, onClose, onDone }: { kind: BulkKind; rows: HierarchyTenantRow[]; tenants: HierarchyTenantRow[]; plans: PlatformPlan[]; onClose: () => void; onDone: () => Promise<void> }) {
  const { success, info, error: showError } = useToast()
  const [busy, setBusy] = useState(false)
  const [planId, setPlanId] = useState('')
  const catalog = useModuleCatalog(kind === 'module')
  const [feature, setFeature] = useState('')
  const [source, setSource] = useState(String(tenants.find(t => !rows.some(r => r.id === t.id))?.id ?? ''))
  const [rules, setRules] = useState<WorkflowRuleTemplate[] | null>(null)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [servers, setServers] = useState<HierarchyServer[] | null>(null)
  const [result, setResult] = useState<string[] | null>(null)
  useEffect(() => { if (kind === 'move') platformApi.hierarchyServers().then(({ data }) => setServers(data)).catch(() => setServers([])) }, [kind])
  useEffect(() => { setRules(null); if (kind === 'workflow' && source) platformApi.tenantWorkflowTemplates(Number(source)).then(({ data }) => setRules(data)).catch(() => setRules([])) }, [kind, source])
  const names = rows.map(r => r.name).join(', ')
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(false) } }
  const settled = (results: PromiseSettledResult<unknown>[]) => results.filter(r => r.status === 'rejected').length

  const content: Record<BulkKind, { title: string; body: ReactNode; go?: () => Promise<void>; label?: string; danger?: boolean }> = {
    suspend: { title: `Suspend ${rows.length} tenants`, label: 'Suspend', danger: true, body: <p>Users of {names} will be blocked from signing in immediately. Data and billing are retained.</p>, go: async () => {
      const res = await Promise.allSettled(rows.filter(r => r.status !== 'suspended').map(r => platformApi.suspendTenant(r.id)))
      const queued = res.filter(r => r.status === 'fulfilled' && isApprovalQueued((r.value as { data: unknown }).data)).length
      if (settled(res)) showError(`${settled(res)} tenant(s) could not be suspended`)
      if (queued) info('Sent for approval', `${queued} suspension(s) are waiting for approval`); else if (!settled(res)) success(`${res.length} tenant(s) suspended`)
      await onDone(); onClose()
    } },
    plan: { title: `Change plan · ${rows.length} tenants`, label: 'Change plan', body: <div className="space-y-2.5"><p>{names}</p><Field label="New plan"><select className={inputCls} style={inputStyle} value={planId} onChange={e => setPlanId(e.target.value)}><option value="">— Select —</option>{plans.map(p => <option key={p.id} value={p.id}>{p.name} · {inr(p.price_monthly)} / month</option>)}</select></Field><small style={{ color: C.mu }}>Plan history is recorded for each tenant.</small></div>, go: async () => {
      const plan = plans.find(p => String(p.id) === planId); if (!plan) return showError('Choose a plan')
      const res = await Promise.allSettled(rows.map(r => platformApi.updateTenant(r.id, { plan_id: plan.id })))
      if (settled(res)) showError(`${settled(res)} tenant(s) could not be updated`); else success(`Plan changed to ${plan.name}`)
      await onDone(); onClose()
    } },
    workflow: { title: `Push workflow template · ${rows.length} tenants`, label: 'Push template', body: <div className="space-y-2.5">
      <Field label="Template source (approval workflows of)"><select className={inputCls} style={inputStyle} value={source} onChange={e => setSource(e.target.value)}><option value="">— Select —</option>{tenants.filter(t => !rows.some(r => r.id === t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      {source && (rules == null ? <small style={{ color: C.mu }}>Loading…</small> : <div className="max-h-48 overflow-auto rounded-lg border" style={{ borderColor: C.ln }}>{rules.length ? rules.map(r => <div key={r.id} className="flex items-center gap-2 border-b px-2 py-1 text-xs last:border-0" style={{ borderColor: C.ln2 }}><span className="flex-1">{r.module} · {r.action}{r.requester_group_name ? ` (${r.requester_group_name})` : ''} · {r.steps.length} step(s)</span>{r.portable ? <Pill t="ok">Portable</Pill> : <Pill t="mu" title={r.not_portable_reason || ''}>Skipped</Pill>}</div>) : <div className="p-2 text-xs" style={{ color: C.mu }}>No approval workflows in this tenant.</div>}</div>)}
      <small className="block" style={{ color: C.mu }}>Copies into {names}. Org groups are matched by name; existing rules are kept.</small>
      {result && <Note info>{result.map(l => <div key={l}>{l}</div>)}</Note>}
    </div>, go: async () => {
      if (!source) return showError('Choose a template source')
      const { data } = await platformApi.pushWorkflowTemplate(Number(source), rows.map(r => r.id))
      setResult(data.results.map(r => r.error ? `${r.tenant}: failed – ${r.error}` : `${r.tenant}: ${r.copied.length} copied, ${r.skipped.length} skipped`))
      success('Workflow template pushed'); await onDone()
    } },
    module: { title: `Enable module · ${rows.length} tenants`, label: 'Enable module', body: <div className="space-y-2.5"><p>{names}</p><Field label="Module"><select className={inputCls} style={inputStyle} value={feature} onChange={e => setFeature(e.target.value)}><option value="">— Select —</option>{(catalog.mods || []).filter(switchable).map(m => <option key={m.key} value={m.key}>{m.name} ({m.section_label})</option>)}</select></Field>
      {catalog.err && <Note>{catalog.err}</Note>}</div>, go: async () => {
      const mod = catalog.byKey.get(feature); if (!mod) return showError('Choose a module')
      const res = await Promise.allSettled(rows.map(async r => {
        const { data } = await platformApi.getTenantFeatures(r.id)
        const missing = mod.feature_ids.filter(i => !data.feature_ids.includes(i))
        if (missing.length) await platformApi.updateTenantFeatures(r.id, [...data.feature_ids, ...missing])
      }))
      if (settled(res)) showError(`${settled(res)} tenant(s) could not be updated`); else success(`Enabled ${mod.name} for ${rows.length} tenant(s)`)
      await onDone(); onClose()
    } },
    announce: { title: `Send announcement · ${rows.length} tenants`, label: 'Send announcement', body: <div className="space-y-2.5"><p>Every active user of {names} receives an in-app notification.</p>
      <Field label="Title"><input className={inputCls} style={inputStyle} value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="Message"><textarea className={inputCls} rows={4} style={inputStyle} value={message} onChange={e => setMessage(e.target.value)} /></Field>
      {result && <Note info>{result.map(l => <div key={l}>{l}</div>)}</Note>}</div>, go: async () => {
      if (!title.trim() || !message.trim()) return showError('Enter a title and a message')
      const { data } = await platformApi.sendAnnouncement(rows.map(r => r.id), title, message)
      setResult(data.results.map(r => r.error ? `${r.tenant}: failed` : `${r.tenant}: ${r.recipients} users notified`))
      success('Announcement sent')
    } },
    move: { title: `Move cluster · ${rows.length} tenants`, body: <div className="space-y-2.5">
      <p>Current placement: {rows.map(r => `${r.name} → ${r.server || 'not found'}`).join(' · ')}</p>
      {servers == null ? <small style={{ color: C.mu }}>Loading servers…</small> : <Field label="Target server"><select className={inputCls} style={inputStyle} disabled>{servers.map(s => <option key={s.name}>{s.name} · {s.region} · {s.databases} databases · {s.status || 'unknown'}</option>)}</select></Field>}
      <Note>{servers && servers.length < 2 ? `Only one database server (${servers[0]?.name || '—'}) is configured, so there is no target to move to.` : 'Moving a tenant database to another server is not available yet: every tenant connects through the shared TENANT_DB_HOST, so a moved database would not be reachable.'} Add servers in PLATFORM_SERVERS to see them here.</Note>
    </div> },
  }
  const c = content[kind]
  return <BwModal title={c.title} width={560} onClose={onClose} foot={<><Btn onClick={onClose}>{result ? 'Close' : 'Cancel'}</Btn>{c.go && !result && (c.danger ? <Btn d disabled={busy} onClick={() => void run(c.go!)}>{busy ? 'Working…' : c.label}</Btn> : <Btn p disabled={busy} onClick={() => void run(c.go!)}>{busy ? 'Working…' : c.label}</Btn>)}</>}>{c.body}</BwModal>
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PlatformTenantsPage() {
  const navigate = useNavigate()
  const { can } = usePlatformAccess()
  const canManage = can('tenants', 'manage')
  const { error: showError } = useToast()
  const [searchParams] = useSearchParams()
  const [view, setView] = useState<View>(() => { try { return (sessionStorage.getItem('bw-tenant-view') as View) || 'Table' } catch { return 'Table' } })
  const [tenants, setTenants] = useState<HierarchyTenantRow[]>([])
  const [groups, setGroups] = useState<HierarchyGroupRow[]>([])
  const [plans, setPlans] = useState<PlatformPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [wizard, setWizard] = useState<'tenant' | 'group' | null>(null)
  const [bulk, setBulk] = useState<{ kind: BulkKind; rows: HierarchyTenantRow[] } | null>(null)
  const [openKpi, kpiPopup] = useKpiPopup()
  useEffect(() => { try { sessionStorage.setItem('bw-tenant-view', view) } catch { /* ignore */ } }, [view])

  const load = useCallback(async () => {
    try { const { data } = await platformApi.tenantHierarchy(); setTenants(data.tenants); setGroups(data.groups) } catch (err) { showError(errMsg(err, 'Unable to load tenants')) } finally { setLoading(false) }
  }, [showError])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    platformApi.listPlans().then(({ data }) => setPlans(data)).catch(() => undefined)
  }, [])

  const groupHealth = (g: HierarchyGroupRow) => { const hs = tenants.filter(t => t.parent_group_id === g.id && t.health != null).map(t => t.health as number); return hs.length ? Math.round(hs.reduce((a, b) => a + b, 0) / hs.length) : null }
  const rows: Row[] = useMemo(() => [...groups, ...tenants], [groups, tenants])
  const link = (r: Row) => r.kind === 'group' ? `/platform/tenant-groups/${r.id}` : `/platform/tenants/${r.id}`
  const tenantOnly = (fn: (rs: HierarchyTenantRow) => number) => (r: Row) => r.kind === 'tenant' ? fn(r) : 0
  const cols: GridCol<Row>[] = [
    { k: 'name', t: 'Tenant', w: 250, txt: r => `${r.name} ${r.kind === 'tenant' ? r.subdomain : r.slug}`, sv: r => r.name,
      fn: r => <><Link to={link(r)} onClick={e => e.stopPropagation()} className="font-bold hover:underline" style={{ color: C.ac }}>{r.name}</Link><br /><small style={{ color: C.mu }}>{r.kind === 'tenant' ? r.subdomain : r.slug}</small></> },
    { k: 'type', t: 'Type', w: 120, txt: typeText, fn: typePill },
    { k: 'parent', t: 'Parent', txt: r => r.kind === 'tenant' && r.parent_name ? r.parent_name : '—' },
    { k: 'plan', t: 'Plan', w: 130, txt: r => r.plan_name || '—' },
    { k: 'industry', t: 'Industry', txt: r => r.industry || '—' },
    { k: 'shard', t: 'Shard', w: 100, txt: r => r.kind === 'tenant' ? r.server || '—' : '—', fn: r => r.kind === 'tenant' ? r.server || '—' : '—' },
    { k: 'users', t: 'Users', w: 80, r: true, sum: true, sv: r => r.users ?? 0, sumv: tenantOnly(t => t.users ?? 0), txt: r => num(r.users) },
    { k: 'storage', t: 'Storage', w: 100, r: true, sum: true, sv: r => r.storage_mb, sumv: tenantOnly(t => t.storage_mb), sumFmt: gb, txt: r => gb(r.storage_mb) },
    { k: 'health', t: 'Health', w: 130, sv: r => (r.kind === 'tenant' ? r.health : groupHealth(r)) ?? -1, txt: r => String((r.kind === 'tenant' ? r.health : groupHealth(r)) ?? '—'), fn: r => healthBar(r.kind === 'tenant' ? r.health : groupHealth(r)) },
    { k: 'mrr', t: 'MRR', w: 110, r: true, sum: true, money: true, sv: r => r.mrr, sumv: tenantOnly(t => t.mrr), txt: r => inr(r.mrr) },
    { k: 'status', t: 'Status', w: 100, txt: r => cap(r.status), fn: r => <><Pill t={statusTone(r.status)}>{cap(r.status)}</Pill>{r.kind === 'tenant' && r.deletion_scheduled_at && <> <Pill t="ba" title={`Deletion scheduled ${fd(r.deletion_scheduled_at)}`}>Deleting</Pill></>}</> },
    { k: 'created', t: 'Created', w: 120, date: true, sv: r => r.created_at, txt: r => fd(r.created_at) },
  ]
  const forBulk = (kind: BulkKind) => (selected: Row[]) => {
    const ts = selected.filter((r): r is HierarchyTenantRow => r.kind === 'tenant')
    if (!ts.length) return showError('Select at least one company – parent groups have no workspace of their own')
    if (!canManage) return showError('Your platform role can’t change tenants')
    setBulk({ kind, rows: ts })
  }
  const tree: Row[] = [...groups.flatMap(g => [g as Row, ...tenants.filter(t => t.parent_group_id === g.id)]), ...tenants.filter(t => !t.parent_group_id)]

  return <div>
    {wizard && <CreateWizard group={wizard === 'group'} groups={groups} tenants={tenants} plans={plans} onClose={() => setWizard(null)} onCreated={path => { setWizard(null); navigate(path) }} />}
    {kpiPopup}
    {bulk && <BulkModal kind={bulk.kind} rows={bulk.rows} tenants={tenants} plans={plans} onClose={() => setBulk(null)} onDone={load} />}

    <PageHead crumb="Platform" title="Tenants & hierarchy" cnt={<>{[['tenants.companies', 'Companies', `${tenants.length} companies`], ['tenants.groups', 'Parent groups', `${groups.length} groups`]].map(([kpi, title, text], i) => <span key={kpi}>{i ? ' · ' : ''}<button type="button" className="hover:underline" title={`${title} — click for details`} onClick={() => openKpi({ kpi, title, value: text.split(' ')[0] })}>{text}</button></span>)}</>}>
      <div className="flex" role="group" aria-label="View">{(['Table', 'Hierarchy'] as View[]).map((v, i) => <button key={v} type="button" aria-pressed={v === view} onClick={() => setView(v)} className={`bw-btn s ${v === view ? 'p' : ''} ${i ? '!rounded-l-none !border-l-0' : '!rounded-r-none'}`}>{v}</button>)}</div>
      {canManage && <Btn onClick={() => setWizard('group')}><Ic n="building" /> New parent group</Btn>}
      {canManage && <Btn p onClick={() => setWizard('tenant')}><Ic n="plus" /> New tenant</Btn>}
    </PageHead>
    <Note info className="mb-2">Each company is an <b>isolated tenant</b> (own MariaDB database, users, roles, workflows, forms, data). A parent group gets a consolidated view and may open any of its companies.</Note>

    <div className="bw-panel">
      {loading ? <Empty>Loading tenants…</Empty> : view === 'Table'
        ? <BwGrid id="pt" cols={cols} rows={rows} rid={r => `${r.kind}-${r.id}`} onRow={r => navigate(link(r))} initialQuery={searchParams.get('search') ?? ''} empty="No tenants found"
          bulk={[['Suspend', forBulk('suspend')], ['Change plan', forBulk('plan')], ['Push workflow template', forBulk('workflow')], ['Enable module', forBulk('module')], ['Send announcement', forBulk('announce')], ['Move cluster', forBulk('move')]]} />
        : <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 980 }}>
          <thead><tr><th>Tenant</th><th>Type</th><th>Plan</th><th className="text-right">Users</th><th className="text-right">Tender steps</th><th>Isolation</th><th>Parent can see</th><th>Status</th><th /></tr></thead>
          <tbody>{tree.map(r => <tr key={`${r.kind}-${r.id}`}>
            <td style={{ paddingLeft: 8 + (r.kind === 'tenant' && r.parent_group_id ? 22 : 0) }}><span style={{ color: r.color || C.ac }}>●</span> <Link to={link(r)} className="font-bold hover:underline" style={{ color: C.ac }}>{r.name}</Link>{r.kind === 'tenant' && <><br /><small className="pl-3.5" style={{ color: C.mu }}>{r.subdomain}</small></>}</td>
            <td>{typePill(r)}</td>
            <td>{r.plan_name || '—'}</td>
            <td className="text-right tabular-nums">{num(r.users)}</td>
            <td className="text-right tabular-nums">{r.kind === 'group' ? '—' : r.tender_stages ? <span title={r.tender_stages.join(' → ')}>{r.tender_stages.length}</span> : '—'}</td>
            <td>{r.kind === 'group' ? 'Consolidated view' : <>Database <code className="text-xs">{r.db_name}</code></>}</td>
            <td>{r.kind === 'group' ? '—' : r.parent_group_id ? PARENT_CAN_SEE[r.parent_visibility] : 'n/a'}</td>
            <td><Pill t={statusTone(r.status)}>{cap(r.status)}</Pill></td>
            <td className="text-right">{r.kind === 'tenant' ? <Btn s onClick={() => openWorkspace(r)} title="Opens the tenant’s sign-in page">Open workspace</Btn> : <Btn s onClick={() => navigate(link(r))} title="Opens the group’s consolidated view">Open workspace</Btn>}</td>
          </tr>)}</tbody>
        </table></div>}
    </div>
  </div>
}
