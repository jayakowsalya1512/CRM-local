import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Pencil, Plus } from 'lucide-react'
import {
  platformApi,
  type HierarchyTenantRow, type ParentVisibility, type PlatformAuditRow, type PlatformPlan, type TenantGroupDetail, type TenantGroupReport, type TenantUserRow,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import {
  Btn, BwModal, C, Empty, Field, HBars, Kv, Loading, Note, Panel, Pill, Strip, Switch, Table, Tabs, VISIBILITY_LABEL,
  cap, errMsg, fd, inputCls, inputStyle, inr, mb, num, statusTone,
} from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import { AuditTable, TENANT_TABS, UsersTable } from './PlatformTenantDetailPage'

type Ctx = { g: TenantGroupDetail; reload: () => Promise<void>; canManage: boolean }

function CompanyLinks({ g, what }: { g: TenantGroupDetail; what: string }) {
  return <div className="space-y-2">
    <Note info>{what}</Note>
    <Panel title={`Companies in ${g.name}`} flush>{!g.companies.length ? <Empty>No companies in this group yet.</Empty> : <div>{g.companies.map(c => <div key={c.id} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}><span style={{ color: c.color || C.ac }}>●</span><Link to={`/platform/tenants/${c.id}`} className="flex-1 font-semibold" style={{ color: C.tx }}>{c.name}</Link><code className="text-xs" style={{ color: C.mu }}>{c.db_name}</code><Pill t={statusTone(c.status)}>{cap(c.status)}</Pill></div>)}</div>}</Panel>
  </div>
}

function EditGroupModal({ g, onClose, onSaved }: { g: TenantGroupDetail; onClose: () => void; onSaved: () => void }) {
  const { success, error: showError } = useToast()
  const [plans, setPlans] = useState<PlatformPlan[]>([])
  const [form, setForm] = useState({ name: g.name, industry: g.industry || '', color: g.color || '#5646C2', plan_id: g.plan_id ? String(g.plan_id) : '', default_visibility: g.default_visibility, notes: g.notes || '' })
  useEffect(() => { platformApi.listPlans().then(({ data }) => setPlans(data)).catch(() => undefined) }, [])
  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v }))
  const save = async () => {
    if (!form.name.trim()) return showError('Enter a name first')
    try {
      await platformApi.updateTenantGroup(g.id, { name: form.name.trim(), industry: form.industry.trim() || null, color: form.color, plan_id: form.plan_id ? Number(form.plan_id) : null, default_visibility: form.default_visibility, notes: form.notes.trim() || null })
      success('Parent group updated'); onSaved()
    } catch (err) { showError(errMsg(err, 'Unable to save')) }
  }
  return <BwModal title={`Edit ${g.name}`} onClose={onClose} width={560} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p onClick={() => void save()}>Save</Btn></>}>
    <div className="grid gap-2.5 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Parent group name *"><input className={inputCls} style={inputStyle} value={form.name} onChange={e => set('name', e.target.value)} /></Field></div>
      <Field label="Industry"><input className={inputCls} style={inputStyle} value={form.industry} onChange={e => set('industry', e.target.value)} /></Field>
      <Field label="Group plan"><select className={inputCls} style={inputStyle} value={form.plan_id} onChange={e => set('plan_id', e.target.value)}><option value="">— None —</option>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Default parent visibility (new companies)"><select className={inputCls} style={inputStyle} value={form.default_visibility} onChange={e => set('default_visibility', e.target.value)}>{(Object.keys(VISIBILITY_LABEL) as ParentVisibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}</select></Field>
      <Field label="Brand colour"><input type="color" className="h-7 w-full rounded-md border px-1" style={inputStyle} value={form.color} onChange={e => set('color', e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="Notes"><textarea className="w-full rounded-md border px-2 py-1 text-[13px]" style={inputStyle} rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} /></Field></div>
    </div>
  </BwModal>
}

function ConsolidatedReport({ g }: { g: TenantGroupDetail }) {
  const [report, setReport] = useState<TenantGroupReport | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { platformApi.tenantGroupReport(g.id).then(r => setReport(r.data)).catch(err => setError(errMsg(err, 'Unable to load report'))) }, [g.id])
  if (error) return <Note>{error}</Note>
  if (!report) return <Loading />
  return <Panel title="Consolidated view · group reporting" flush act={<small className="text-xs font-normal" style={{ color: C.mu }}>Companies with visibility Full or Reports only</small>}>
    {!report.companies.length ? <Empty>No company shares data with this group.</Empty> : <Table head={['Company', 'Visibility', { t: 'Users', r: true }, { t: 'Weekly active', r: true }, ...report.record_labels.map(l => ({ t: l, r: true })), { t: 'Storage', r: true }, { t: 'Database', r: true }, { t: 'MRR', r: true }]} minWidth={900}>
      {report.companies.map(c => <tr key={c.id}><td><Link to={`/platform/tenants/${c.id}`} className="font-semibold" style={{ color: C.tx }}>{c.name}</Link>{!c.available && <> <Pill t="ba">DB unreachable</Pill></>}</td><td><Pill t={c.visibility === 'full' ? 'ok' : 'inf'}>{c.visibility === 'full' ? 'Full' : 'Reports only'}</Pill></td><td className="text-right">{num(c.users)}</td><td className="text-right">{num(c.weekly_active)}</td>{report.record_labels.map(l => <td key={l} className="text-right">{c.records[l] == null ? '—' : num(c.records[l])}</td>)}<td className="text-right">{mb(c.storage_mb)}</td><td className="text-right">{mb(c.db_size_mb)}</td><td className="text-right">{inr(c.mrr)}</td></tr>)}
      <tr className="font-semibold"><td>Group total</td><td /><td className="text-right">{num(report.totals.users)}</td><td className="text-right">{num(report.totals.weekly_active)}</td>{report.record_labels.map(l => <td key={l} className="text-right">{num(report.totals.records[l])}</td>)}<td className="text-right">{mb(report.totals.storage_mb)}</td><td className="text-right">{mb(report.totals.db_size_mb)}</td><td className="text-right">{inr(report.totals.mrr)}</td></tr>
    </Table>}
    {report.excluded.length > 0 && <div className="border-t px-2.5 py-1.5 text-xs" style={{ borderColor: C.ln2, color: C.mu }}>Excluded (tenant isolation): {report.excluded.map(e => e.name).join(', ')}</div>}
  </Panel>
}

function OverviewTab({ g, reload, canManage, ask, edit }: Ctx & { ask: (t: string, body: ReactNode, label: string, run: () => Promise<void>, danger?: boolean) => void; edit: () => void }) {
  const { success } = useToast()
  const gq = { facet: g.name }  // the specs' breakdown is the parent group, so the popup opens on this group's companies
  return <div className="space-y-2">
    <div className="grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-2">
        <Panel title="Profile"><Kv rows={[['Group ID', `#${g.id} · ${g.slug.toUpperCase()}`], ['Type', 'Parent group'], ['Industry', g.industry || '—'], ['Created', fd(g.created_at)], ['Plan', g.plan_name || '—'], ['Companies', g.children], ['Default visibility', VISIBILITY_LABEL[g.default_visibility]], ['Database', '— (consolidation only)']]} />{g.notes && <p className="mt-2 text-xs" style={{ color: C.mu }}>{g.notes}</p>}</Panel>
        <Panel title="Usage across companies"><HBars rows={g.companies.map(c => ({ l: `${c.name} · ${num(c.users)} users`, v: c.max_users && (c.active_users ?? c.users) != null ? (c.active_users ?? c.users)! / c.max_users * 100 : null }))} lw={260} />{!g.companies.length && <Empty>No companies yet.</Empty>}</Panel>
      </div>
      <div className="space-y-2">
        <Strip items={[{ l: 'Users', v: num(g.users), kpi: 'group.users', kpiQuery: gq }, { l: 'Storage', v: mb(g.storage_mb), kpi: 'group.storage', kpiQuery: gq }, { l: 'MRR', v: inr(g.mrr), kpi: 'group.mrr', kpiQuery: gq }]} />
        <Panel title="Quick actions"><div className="grid gap-1.5">
          {canManage && <Link to={`/platform/onboarding?new=1&group=${g.id}`} className="inline-flex h-7 items-center gap-1.5 rounded-md border px-[11px] font-medium text-white" style={{ background: C.ac, borderColor: C.ac, color: '#fff' }}><Plus size={14} /> New company in this group</Link>}
          {canManage && <Btn onClick={edit}><Pencil size={14} /> Edit parent group</Btn>}
          {canManage && (g.status === 'suspended'
            ? <Btn d onClick={() => ask('Reactivate parent group', <p>Reactivate this group?</p>, 'Yes, continue', async () => { await platformApi.reactivateTenantGroup(g.id); success('Group active'); await reload() })}>Reactivate group</Btn>
            : <Btn d onClick={() => ask('Suspend parent group', <p>Suspend {g.name}? Companies keep working; the group’s consolidated access is paused.</p>, 'Yes, continue', async () => { await platformApi.suspendTenantGroup(g.id); success('Group suspended'); await reload() }, true)}>Suspend group</Btn>)}
        </div></Panel>
      </div>
    </div>
    <ConsolidatedReport g={g} />
  </div>
}

function UsersTab({ g, canManage }: Ctx) {
  const [data, setData] = useState<{ users: TenantUserRow[]; hidden_companies: { id: number; name: string; visibility: ParentVisibility }[] } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => { try { setData((await platformApi.tenantGroupUsers(g.id)).data) } catch (err) { setError(errMsg(err, 'Unable to load users')) } }, [g.id])
  useEffect(() => { void load() }, [load])
  if (error) return <Note>{error}</Note>
  if (!data) return <Loading />
  return <div className="space-y-2">
    {data.hidden_companies.length > 0 && <Note>Not shown – parent visibility is not “Full data &amp; workspace access”: {data.hidden_companies.map(h => `${h.name} (${h.visibility === 'reports' ? 'reports only' : 'isolated'})`).join(', ')}</Note>}
    <Panel title={`Users (${data.users.length})`} flush><UsersTable users={data.users} onChanged={load} canManage={canManage} showCompany /></Panel>
  </div>
}

function MeteringTab({ g }: Ctx) {
  return <Panel title="Metering · by company" flush>{!g.companies.length ? <Empty>No companies yet.</Empty> : <Table head={['Company', { t: 'Users', r: true }, { t: 'Max users', r: true }, { t: 'Storage', r: true }, { t: 'Storage limit', r: true }, { t: 'Database', r: true }]} minWidth={640}>
    {g.companies.map(c => <tr key={c.id}><td><Link to={`/platform/tenants/${c.id}?tab=Limits+%26+metering`} style={{ color: C.tx }} className="font-semibold">{c.name}</Link></td><td className="text-right">{num(c.users)}</td><td className="text-right">{num(c.max_users)}</td><td className="text-right">{mb(c.storage_mb)}</td><td className="text-right">{mb(c.storage_limit_mb)}</td><td className="text-right">{mb(c.db_size_mb)}</td></tr>)}
    <tr className="font-semibold"><td>Group total</td><td className="text-right">{num(g.users)}</td><td className="text-right">{num(g.companies.reduce((a, c) => a + c.max_users, 0))}</td><td className="text-right">{mb(g.storage_mb)}</td><td className="text-right">{mb(g.companies.reduce((a, c) => a + c.storage_limit_mb, 0))}</td><td className="text-right">{mb(g.db_size_mb)}</td></tr>
  </Table>}</Panel>
}

function BillingTab({ g, reload, canManage }: Ctx) {
  const { success, error: showError } = useToast()
  const [plans, setPlans] = useState<PlatformPlan[]>([])
  useEffect(() => { platformApi.listPlans().then(({ data }) => setPlans(data)).catch(() => undefined) }, [])
  const setPlan = async (planId: string) => { try { await platformApi.updateTenantGroup(g.id, { plan_id: planId ? Number(planId) : null }); success('Group plan updated'); await reload() } catch (err) { showError(errMsg(err, 'Unable to update plan')) } }
  return <div className="grid gap-2 xl:grid-cols-2">
    <Panel title="Subscription"><div className="grid gap-2.5 sm:grid-cols-2">
      <Field label="Group plan"><select className={inputCls} style={inputStyle} value={g.plan_id ?? ''} disabled={!canManage} onChange={e => void setPlan(e.target.value)}><option value="">— None —</option>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Consolidated MRR"><input className={inputCls} style={inputStyle} disabled value={inr(g.mrr)} /></Field>
    </div><p className="mt-2 text-xs" style={{ color: C.mu }}>Each company is billed on its own plan; the group total is the sum of its active companies.</p></Panel>
    <Panel title="Companies" flush>{!g.companies.length ? <Empty>No companies yet.</Empty> : <Table head={['Company', 'Plan', 'Status', { t: 'MRR', r: true }]} minWidth={420}>{g.companies.map(c => <tr key={c.id}><td><Link to={`/platform/tenants/${c.id}?tab=Billing`} style={{ color: C.tx }} className="font-semibold">{c.name}</Link></td><td>{c.plan_name || '—'}</td><td><Pill t={statusTone(c.status)}>{cap(c.status)}</Pill></td><td className="text-right">{inr(c.mrr)}</td></tr>)}</Table>}</Panel>
  </div>
}

function HierarchyTab({ g, reload, canManage }: Ctx) {
  const { success, error: showError } = useToast()
  const [standalone, setStandalone] = useState<HierarchyTenantRow[]>([])
  const [pick, setPick] = useState('')
  useEffect(() => { platformApi.tenantHierarchy().then(({ data }) => setStandalone(data.tenants.filter(t => !t.parent_group_id))).catch(() => undefined) }, [g.companies.length])
  const save = async (tenantId: number, patch: Parameters<typeof platformApi.setTenantHierarchy>[1], msg: string) => {
    try { await platformApi.setTenantHierarchy(tenantId, patch); success(msg); await reload() } catch (err) { showError(errMsg(err, 'Unable to update hierarchy')) }
  }
  return <div className="space-y-2">
    <Note info><b>{g.name}</b> is a parent group. Choose how much of each company the group can see. Every company keeps its own isolated database; sibling companies never see each other.</Note>
    <Panel title="Child companies" flush>{!g.companies.length ? <Empty>No companies in this group yet.</Empty> : <Table head={['Company', 'Parent visibility', 'Isolation', 'Shared masters', 'Status', '']} minWidth={860}>
      {g.companies.map(c => <tr key={c.id}>
        <td><Link to={`/platform/tenants/${c.id}`} className="font-semibold" style={{ color: C.tx }}>{c.name}</Link></td>
        <td><select className={`${inputCls} !w-[220px]`} style={inputStyle} value={c.parent_visibility} disabled={!canManage} onChange={e => void save(c.id, { parent_visibility: e.target.value as ParentVisibility }, `Visibility updated for ${c.name}`)}>{(Object.keys(VISIBILITY_LABEL) as ParentVisibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}</select></td>
        <td><code className="text-xs">{c.db_name}</code>{c.server && <small style={{ color: C.mu }}> · {c.server}</small>}</td>
        <td><Switch on={c.shared_masters} disabled={!canManage} onChange={v => void save(c.id, { shared_masters: v }, `Shared masters ${v ? 'enabled' : 'disabled'} for ${c.name}`)} label={`Shared masters for ${c.name}`} /></td>
        <td><Pill t={statusTone(c.status)}>{cap(c.status)}</Pill></td>
        <td className="text-right">{canManage && <Btn s d onClick={() => void save(c.id, { detach: true }, `${c.name} detached`)}>Detach</Btn>}</td>
      </tr>)}
    </Table>}</Panel>
    {canManage && <Panel title="Add a company to this group"><div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[260px] flex-1"><Field label="Standalone tenant"><select className={inputCls} style={inputStyle} value={pick} onChange={e => setPick(e.target.value)}><option value="">— Select —</option>{standalone.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field></div>
      <Btn p disabled={!pick} onClick={() => void save(Number(pick), { parent_group_id: g.id }, 'Company attached').then(() => setPick(''))}>Attach</Btn>
      <Link to={`/platform/onboarding?new=1&group=${g.id}`} className="inline-flex h-7 items-center gap-1 rounded-md border px-[11px] font-medium" style={{ borderColor: C.ln, background: C.sf, color: C.tx }}><Plus size={14} /> New company</Link>
    </div><p className="mt-1.5 text-xs" style={{ color: C.mu }}>New companies get the group default visibility: {VISIBILITY_LABEL[g.default_visibility]}.</p></Panel>}
  </div>
}

function LifecycleTab({ g, reload, canManage, ask }: Ctx & { ask: (t: string, body: ReactNode, label: string, run: () => Promise<void>, danger?: boolean, typed?: string) => void }) {
  const { success } = useToast()
  const navigate = useNavigate()
  const rows: [string, string, ReactNode][] = [
    g.status === 'suspended'
      ? ['Reactivate group', 'Restore the group’s consolidated view.', <Btn key="r" onClick={() => ask('Reactivate parent group', <p>Reactivate {g.name}?</p>, 'Yes, continue', async () => { await platformApi.reactivateTenantGroup(g.id); success('Group active'); await reload() })}>Reactivate</Btn>]
      : ['Suspend group', 'Pause the group’s consolidated access. Companies keep working.', <Btn key="s" onClick={() => ask('Suspend parent group', <p>Suspend {g.name}?</p>, 'Yes, continue', async () => { await platformApi.suspendTenantGroup(g.id); success('Group suspended'); await reload() }, true)}>Suspend</Btn>],
    ['Delete parent group', g.children ? `Detach all ${g.children} companies first (Hierarchy tab).` : 'Removes the group. Companies are not affected.',
      <Btn key="d" d disabled={g.children > 0} onClick={() => ask(`Delete ${g.name}`, <Note>The parent group is removed permanently. Its companies stay as standalone tenants.</Note>, 'Delete group', async () => { await platformApi.deleteTenantGroup(g.id, g.name); success('Parent group deleted'); navigate('/platform/tenants') }, true, g.name)}>Delete…</Btn>],
  ]
  return <div className="rounded-md border" style={{ borderColor: C.ln, background: C.sf }}>{rows.map(([t, d, b]) => <div key={t} className="flex items-center gap-2 border-b px-2.5 py-2 last:border-0" style={{ borderColor: C.ln2 }}><span className="flex-1"><b>{t}</b><br /><small className="text-xs" style={{ color: C.mu }}>{d}</small></span>{canManage && b}</div>)}</div>
}

function AuditTab({ g }: Ctx) {
  const [rows, setRows] = useState<PlatformAuditRow[] | null>(null)
  useEffect(() => { platformApi.tenantGroupAudit(g.id).then(r => setRows(r.data)).catch(() => setRows([])) }, [g.id])
  return <Panel title="Recent events" flush>{!rows ? <Loading /> : <AuditTable rows={rows} />}</Panel>
}

export default function PlatformTenantGroupDetailPage() {
  const id = Number(useParams().id)
  const [params, setParams] = useSearchParams()
  const tab = (TENANT_TABS as readonly string[]).includes(params.get('tab') || '') ? params.get('tab')! : 'Overview'
  const { can } = usePlatformAccess()
  const canManage = can('tenants', 'manage')
  const { error: showError } = useToast()
  const [g, setG] = useState<TenantGroupDetail | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; body: ReactNode; label: string; run: () => Promise<void>; danger?: boolean; typed?: string } | null>(null)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = useCallback(async () => { try { setG((await platformApi.getTenantGroup(id)).data); setError('') } catch (err) { setError(errMsg(err, 'Unable to load parent group')) } }, [id])
  useEffect(() => { void reload() }, [reload])
  if (error) return <div className="page-body"><Note>{error}</Note></div>
  if (!g) return <div className="page-body"><Loading /></div>
  const ctx: Ctx = { g, reload, canManage }
  const ask = (title: string, body: ReactNode, label: string, run: () => Promise<void>, danger?: boolean, confirmName?: string) => { setTyped(''); setConfirm({ title, body, label, run, danger, typed: confirmName }) }
  const runConfirm = async () => {
    if (!confirm) return
    if (confirm.typed && typed.trim() !== confirm.typed) return showError('Name does not match')
    setBusy(true)
    try { await confirm.run(); setConfirm(null) } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(false) }
  }
  const body: Record<string, () => ReactNode> = {
    Overview: () => <OverviewTab {...ctx} ask={ask} edit={() => setEditing(true)} />,
    'Settings overrides': () => <CompanyLinks g={g} what="Settings overrides are set per company. Companies that inherit parent policies follow the group’s roles and approval policy." />,
    'Contract & discounts': () => <CompanyLinks g={g} what="Contracts and discounts are set per company." />,
    Database: () => <CompanyLinks g={g} what="Groups have no database of their own – they read their companies’ databases through the consolidation layer. Open a company to manage its database." />,
    Monitoring: () => <CompanyLinks g={g} what="Select a company to see its service metrics." />,
    'Backups & recovery': () => <CompanyLinks g={g} what="Backups run per company database." />,
    'Data & migration': () => <CompanyLinks g={g} what="Exports run per company database." />,
    Modules: () => <CompanyLinks g={g} what="Modules are entitled per company." />,
    'Users & access': () => <UsersTab {...ctx} />,
    Configuration: () => <CompanyLinks g={g} what="Configuration is per company." />,
    'Limits & metering': () => <MeteringTab {...ctx} />,
    Billing: () => <BillingTab {...ctx} />,
    Security: () => <CompanyLinks g={g} what="Security policies are set per company." />,
    Hierarchy: () => <HierarchyTab {...ctx} />,
    Lifecycle: () => <LifecycleTab {...ctx} ask={ask} />,
    Audit: () => <AuditTab {...ctx} />,
  }
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {editing && <EditGroupModal g={g} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload() }} />}
    {confirm && <BwModal title={confirm.title} onClose={() => setConfirm(null)} foot={<><Btn onClick={() => setConfirm(null)}>Cancel</Btn>{confirm.danger ? <Btn d onClick={() => void runConfirm()} disabled={busy}>{busy ? 'Working…' : confirm.label}</Btn> : <Btn p onClick={() => void runConfirm()} disabled={busy}>{busy ? 'Working…' : confirm.label}</Btn>}</>}>
      <div className="space-y-2.5">{confirm.body}{confirm.typed && <Field label={`Type ${confirm.typed} to confirm`}><input className={inputCls} style={inputStyle} value={typed} onChange={e => setTyped(e.target.value)} autoFocus /></Field>}</div>
    </BwModal>}
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div>
        <div className="mb-0.5 text-xs" style={{ color: C.mu }}><Link to="/platform/tenants" style={{ color: C.ac }}>Tenants</Link> / {g.name}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-sm font-bold text-white" style={{ background: g.color || C.ac }}>{g.name.charAt(0).toUpperCase()}</span>
          <h1 className="text-xl font-semibold">{g.name}</h1>
          <Pill t={statusTone(g.status)}>{cap(g.status)}</Pill>
          <Pill t="ac">Parent group</Pill>
          <Pill t="mu">{g.children} compan{g.children === 1 ? 'y' : 'ies'}</Pill>
        </div>
      </div>
      <span className="flex-1" />
      {canManage && <Btn onClick={() => setEditing(true)}><Pencil size={14} /> Edit</Btn>}
      {canManage && <Link to={`/platform/onboarding?new=1&group=${g.id}`} className="inline-flex h-7 items-center gap-1.5 rounded-md border px-[11px] font-medium text-white" style={{ background: C.ac, borderColor: C.ac, color: '#fff' }}><Plus size={14} /> New company</Link>}
    </div>
    <div className="rounded-md border" style={{ background: C.sf, borderColor: C.ln }}>
      <Tabs tabs={TENANT_TABS} active={tab} onChange={t => setParams({ tab: t }, { replace: true })} />
      <div className="p-2.5" style={{ background: 'var(--bw-bg)' }}>{body[tab]()}</div>
    </div>
  </div>
}
