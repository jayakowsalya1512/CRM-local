import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, BarChart2, BarChart3, Bell, Boxes, Brain, Briefcase, Building2, ClipboardCheck, ClipboardList, FileText, FolderPlus, LayoutDashboard, LockKeyhole, MailPlus, Palette, PieChart, Receipt, Pencil, Plane, Plus, Search, Settings, Shield, ShieldCheck, Target, TrendingUp, Trash2, Users, X } from 'lucide-react'
import { platformApi, PlatformService } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'

const moduleIcons: Record<string, typeof Boxes> = {
  audit_logs: ClipboardList, dashboard: LayoutDashboard, overview: LayoutDashboard,
  customers: Users, leads: Target, opportunities: TrendingUp, tenders: FileText,
  questionnaire: ClipboardList, quotations: Receipt, workorders: Briefcase,
  emdbg: Shield, kam: Activity, kam360: Activity, travel: Plane,
  login_tracker: LockKeyhole, rfp: Brain, approvals: ClipboardCheck,
  document_management: FileText, letter_management: MailPlus, recycle_bin: Trash2,
  report_engine: BarChart2, reports: PieChart, insights: Activity,
  alerts: AlertTriangle, notifications: Bell, oems: Building2, masters: Building2,
  competitors: Target, users: Users, roles: ShieldCheck, settings: Settings,
  integrations: Boxes, form_builder: ClipboardList, theme: Palette, company: Building2,
  security: LockKeyhole, escalation_overrides: AlertTriangle, auto_approve: ClipboardCheck,
}

export default function PlatformServicesPage() {
  const { success, error: showError } = useToast()
  const [services, setServices] = useState<PlatformService[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [parent, setParent] = useState<PlatformService | null | undefined>(undefined)
  const [editing, setEditing] = useState<PlatformService | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [tenantModal, setTenantModal] = useState<{ module: PlatformService; tenants: Array<{ id: number; name: string; slug: string; subdomain: string; status: string }> | null }>(null)
  const [form, setForm] = useState({ name: '', key: '', module: '', description: '', dependencies: [] as string[], configuration_status: 'ready' as 'ready' | 'needs_configuration' | 'not_applicable', configuration_notes: '' })
  const load = async () => {
    setLoading(true)
    try { setServices((await platformApi.listServices()).data) }
    catch (err: any) { showError(err?.response?.data?.detail || 'Unable to load services') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const openForm = (item: PlatformService | null) => {
    setEditing(null)
    setParent(item)
    setForm({ name: '', key: '', module: item?.module || '', description: '', dependencies: [], configuration_status: 'ready', configuration_notes: '' })
  }
  const edit = (item: PlatformService) => {
    setEditing(item)
    setParent(null)
    setForm({ name: item.name, key: item.key, module: item.module || '', description: item.description || '', dependencies: item.dependencies || [], configuration_status: item.configuration_status || 'ready', configuration_notes: item.configuration_notes || '' })
  }
  // Each row is toggled by its own catalog key, so modules and sub-modules (including
  // "Not linked" ones) change independently. The switch flips immediately and rolls
  // back if the save fails.
  const toggle = async (item: PlatformService) => {
    const key = item.key
    if (busyKeys.has(key)) return
    const previous = item.is_active
    const next = !previous
    setBusyKeys(current => new Set(current).add(key))
    setServices(current => current.map(service => service.key === key ? { ...service, is_active: next } : service))
    try {
      await platformApi.setServiceStatus(key, next)
      success(`${item.name} ${next ? 'activated' : 'deactivated'}`)
    } catch (err: any) {
      setServices(current => current.map(service => service.key === key ? { ...service, is_active: previous } : service))
      showError(err?.response?.data?.detail || 'Unable to update service status')
    } finally {
      setBusyKeys(current => { const rest = new Set(current); rest.delete(key); return rest })
    }
  }
  const showTenants = async (module: PlatformService) => {
    setTenantModal({ module, tenants: null })
    try {
      const { data } = await platformApi.listServiceTenants(module.key)
      setTenantModal(current => current?.module.key === module.key ? { module, tenants: data.tenants } : current)
    } catch (err: any) {
      setTenantModal(null)
      showError(err?.response?.data?.detail || 'Unable to load tenant assignments')
    }
  }
  const remove = async (item: PlatformService) => {
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return
    if (item.id == null) return
    setBusyId(item.id)
    try { await platformApi.deleteService(item.id); await load(); success('Service deleted') }
    catch (err: any) { showError(err?.response?.data?.detail || 'Unable to delete service') }
    finally { setBusyId(null) }
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      if (editing) { if (editing.id != null) await platformApi.updateService(editing.id, { name: form.name.trim(), module: form.module.trim() || 'General', description: form.description }); await platformApi.updateServiceManagement(editing.key, { dependencies: form.dependencies, configuration_status: form.configuration_status, configuration_notes: form.configuration_notes }) }
      else await platformApi.createService({ ...form, name: form.name.trim(), key: form.key.trim().toLowerCase(), module: form.module.trim() || 'General', parent_id: parent?.id ?? undefined })
      success(editing ? 'Service updated' : parent ? 'Sub-service created' : 'Service created')
      setParent(undefined)
      await load()
    } catch (err: any) { showError(err?.response?.data?.detail || 'Unable to create service') }
    finally { setSaving(false) }
  }
  const query = search.trim().toLowerCase()
  const matches = (item: PlatformService) => [item.name, item.key, item.module || ''].some(value => value.toLowerCase().includes(query))
  const roots = services.filter(item => item.parent_id == null && !item.parent_key && (matches(item) || services.some(child => (child.parent_key === item.key || (item.id != null && child.parent_id === item.id)) && matches(child))))
  const field = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100'
  return (
    <div className="page-body space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="page-title">Service Management</h2><p className="page-subtitle">Browse the common tenant services and manage catalog entries.</p></div>
        <button className="btn btn-primary" onClick={() => openForm(null)}><Plus size={16} /> Create Service</button>
      </div>
      <p className="text-xs text-slate-500">Only active services and sub-services are offered in Tenant Onboarding. Changing a status doesn't alter existing tenants' access.</p>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4"><label className="relative block max-w-sm"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className={`${field} pl-9`} aria-label="Search services" placeholder="Search services or categories" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
        {loading ? <div className="p-8 text-center text-sm text-slate-500">Loading services...</div> : roots.length === 0 ? <div className="p-8 text-center text-sm text-slate-500">No services found.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                <tr><th className="w-[52%] px-5 py-3">Service</th><th className="w-[15%] px-4 py-3">Category</th><th className="w-[17%] px-4 py-3">Status</th><th className="w-[16%] px-5 py-3 text-right">Actions</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {roots.map(root => [root, ...services.filter(child => (child.parent_key === root.key || (root.id != null && child.parent_id === root.id)) && (!query || matches(root) || matches(child)))].map(item => {
                  const Icon = moduleIcons[item.key.split('.').pop() || ''] || Boxes
                  const isSubmodule = Boolean(item.parent_id || item.parent_key)
                  return (
                    <tr key={item.id ?? item.key} className="group transition-colors hover:bg-slate-50/70">
                      <td className="px-5 py-3.5">
                        <div className={`flex items-center gap-3 ${isSubmodule ? 'pl-8' : ''}`}>
                          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isSubmodule ? 'bg-slate-100 text-slate-500' : 'bg-blue-50 text-blue-600'}`}><Icon size={17} /></span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2"><span className="font-semibold text-slate-900">{item.name}</span>{isSubmodule && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Sub-service</span>}</div>
                            <p className="mt-0.5 truncate text-xs text-slate-500">{item.description || item.key}</p>
                            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-medium text-slate-500"><button type="button" onClick={() => void showTenants(item)} className="rounded-md bg-blue-50 px-1.5 py-0.5 text-blue-700 hover:bg-blue-100">Tenants {item.tenant_assignments}</button><span className={`rounded-md px-1.5 py-0.5 ${item.configuration_status === 'ready' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>Config {item.configuration_status.replace(/_/g, ' ')}</span></div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5"><span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium capitalize text-slate-600">{item.module || 'General'}</span></td>
                      <td className="px-4 py-3.5"><button type="button" role="switch" aria-label={`${item.is_active ? 'Deactivate' : 'Activate'} ${item.name}`} aria-checked={item.is_active} disabled={busyKeys.has(item.key)} onClick={() => void toggle(item)} className="inline-flex items-center gap-2 text-xs font-semibold disabled:opacity-60"><span className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${item.is_active ? 'bg-emerald-500' : 'bg-slate-300'}`}><span className={`absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${item.is_active ? 'translate-x-[14px]' : 'translate-x-0.5'}`} /></span><span className={item.is_active ? 'text-emerald-700' : 'text-slate-500'}>{item.is_active ? 'Active' : 'Inactive'}</span></button></td>
                      <td className="px-5 py-3.5"><div className="flex justify-end gap-1"><button type="button" title="Edit service configuration" aria-label={`Edit ${item.name}`} className="rounded-md border border-transparent p-1.5 text-slate-500 hover:border-slate-200 hover:bg-white hover:text-blue-600" onClick={() => edit(item)}><Pencil size={15} /></button>{!isSubmodule && <button type="button" title="Add sub-service" aria-label={`Add sub-service to ${item.name}`} className="rounded-md border border-transparent p-1.5 text-slate-500 hover:border-slate-200 hover:bg-white hover:text-blue-600 disabled:opacity-40" disabled={item.id == null} onClick={() => openForm(item)}><FolderPlus size={15} /></button>}<button type="button" title="Delete service" aria-label={`Deactivate ${item.name}`} className="rounded-md border border-transparent p-1.5 text-slate-500 hover:border-red-100 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" disabled={item.id == null || busyId === item.id} onClick={() => void remove(item)}><Trash2 size={15} /></button></div></td>
                    </tr>
                  )
                }))}
              </tbody>
            </table>
          </div>        )}
      </div>
      {tenantModal && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setTenantModal(null)}>
        <div role="dialog" aria-modal="true" aria-labelledby="module-tenants-title" className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h3 id="module-tenants-title" className="font-bold text-slate-900">Tenant assignments</h3><p className="mt-0.5 text-sm text-slate-500">{tenantModal.module.name}</p></div><button type="button" aria-label="Close" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" onClick={() => setTenantModal(null)}><X size={18} /></button></div>
          <div className="max-h-[60vh] overflow-y-auto p-3">{tenantModal.tenants === null ? <div className="py-10 text-center text-sm text-slate-500">Loading tenants...</div> : tenantModal.tenants.length === 0 ? <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500">No tenants are assigned to this service.</div> : <div className="overflow-hidden rounded-xl border border-slate-200"><table className="w-full text-sm"><thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"><tr><th className="px-4 py-3">Tenant</th><th className="px-4 py-3">Subdomain</th><th className="px-4 py-3">Status</th></tr></thead><tbody className="divide-y divide-slate-100">{tenantModal.tenants.map(tenant => <tr key={tenant.id}><td className="px-4 py-3"><div className="font-semibold text-slate-900">{tenant.name}</div><div className="text-xs text-slate-500">{tenant.slug}</div></td><td className="px-4 py-3 text-slate-600">{tenant.subdomain}</td><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium capitalize text-slate-600">{tenant.status}</span></td></tr>)}</tbody></table></div>}</div>
        </div>
      </div>}
      {parent !== undefined && <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/45 backdrop-blur-[2px]" onClick={() => !saving && setParent(undefined)}>
        <form onSubmit={save} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="service-dialog-title" className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
          <div className="flex items-start gap-4 border-b border-slate-100 px-6 py-5"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><Boxes size={22} /></div><div className="min-w-0 flex-1"><h3 id="service-dialog-title" className="text-lg font-bold text-slate-900">{editing ? 'Edit service' : 'Create service'}</h3><p className="mt-1 text-sm text-slate-500">Manage the service catalog and its hierarchy.</p></div><button type="button" aria-label="Close" onClick={() => setParent(undefined)} disabled={saving} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X size={18} /></button></div>
          <div className="flex-1 overflow-y-auto p-6"><div className="rounded-2xl border border-slate-100 p-6"><h4 className="font-semibold text-slate-900">Service details</h4><p className="mt-1 text-sm text-slate-500">The name and identifier tenants will recognize.</p>
            <div className="mt-6 grid gap-5 sm:grid-cols-2"><label className="block text-sm font-medium text-slate-700">Service key *<input className={`${field} mt-1.5`} value={form.key} disabled={!!editing} required maxLength={100} pattern="[a-z0-9_]+" placeholder="asset_management" onChange={e => setForm({ ...form, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /><span className="mt-1 block text-xs text-slate-400">Lowercase letters, numbers, and underscores only.</span></label>
              <label className="block text-sm font-medium text-slate-700">Service name *<input className={`${field} mt-1.5`} value={form.name} disabled={!!editing && editing.id == null} required maxLength={200} placeholder="Asset Management" onChange={e => setForm({ ...form, name: e.target.value })} /></label>
              <label className="block text-sm font-medium text-slate-700">Parent service<select className={`${field} mt-1.5`} value={editing ? (editing.parent_id ?? '') : (parent?.id ?? '')} disabled={!!editing} onChange={e => setParent(services.find(item => item.id === Number(e.target.value)) || null)}><option value="">Top-level service</option>{services.filter(item => item.id != null && !item.parent_id && !item.parent_key).map(item => <option key={item.id} value={item.id!}>{item.name}</option>)}</select>{editing && <span className="mt-1 block text-xs text-slate-400">Parent service cannot be changed after creation.</span>}</label>
              <label className="block text-sm font-medium text-slate-700">Category<input className={`${field} mt-1.5`} value={form.module} disabled={!!editing && editing.id == null} maxLength={100} placeholder="General" onChange={e => setForm({ ...form, module: e.target.value })} /></label>
              <label className="block text-sm font-medium text-slate-700 sm:col-span-2">Description<textarea className={`${field} mt-1.5 resize-y`} rows={5} maxLength={2000} placeholder="What does this service provide?" value={form.description} disabled={!!editing && editing.id == null} onChange={e => setForm({ ...form, description: e.target.value })} /><span className="mt-1 block text-right text-xs text-slate-400">{form.description.length}/2000</span></label></div>
          </div></div>
          <div className="grid grid-cols-2 gap-3 border-t border-slate-100 bg-white px-6 py-4"><button type="button" className="btn btn-outline justify-center" onClick={() => setParent(undefined)} disabled={saving}>Cancel</button><button className="btn btn-primary justify-center" disabled={saving}>{saving ? 'Saving...' : editing ? 'Save changes' : 'Create service'}</button></div>
        </form>
      </div>}
    </div>
  )
}