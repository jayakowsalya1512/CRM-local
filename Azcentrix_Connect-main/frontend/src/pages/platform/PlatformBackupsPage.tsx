import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Building2, Check, CheckCircle2, ChevronDown, ChevronRight, Database, Download, FileText, HardDrive,
  Loader2, RefreshCw, Search, ShieldCheck, X,
} from 'lucide-react'
import api, { platformApi, type PlatformTenant } from '@/services/platformApi'

type Backup = { id: number; tenant_id: number; name: string; status: string; available: boolean; completed_at: string | null; created_at: string; next_run_at: string | null; error: string | null }
type ModuleRow = { key: string; label: string; records: number; storage_bytes: number; table_count: number }
type ModuleStorage = { tenant_id: number; tenant_name: string; total_bytes: number; modules: ModuleRow[] }

const TENANT_STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  trial: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  suspended: 'bg-amber-50 text-amber-700 ring-amber-200',
  cancelled: 'bg-rose-50 text-rose-700 ring-rose-200',
}
const BACKUP_STATUS_STYLE: Record<string, string> = {
  completed: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  failed: 'bg-rose-50 text-rose-700 ring-rose-200',
  in_progress: 'bg-amber-50 text-amber-700 ring-amber-200',
  pending: 'bg-slate-100 text-slate-600 ring-slate-200',
}
const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset'

function formatBytes(bytes: number) {
  if (!bytes) return '0 KB'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const asDate = (iso: string) => new Date(iso.endsWith('Z') ? iso : `${iso}Z`)
function daysAgo(date: Date) {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  return days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
}

function saveBlob(data: Blob, filename: string) {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url; link.download = filename; link.click()
  URL.revokeObjectURL(url)
}

export default function PlatformBackupsPage() {
  const [tenants, setTenants] = useState<PlatformTenant[]>([])
  const [backups, setBackups] = useState<Backup[]>([])
  const [plans, setPlans] = useState<{ id: number; name: string }[]>([])
  const [moduleCounts, setModuleCounts] = useState<Record<number, number>>({})
  const [exportOpen, setExportOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [planFilter, setPlanFilter] = useState('all')
  const [backupFilter, setBackupFilter] = useState('all')
  const [selected, setSelected] = useState<PlatformTenant | null>(null)
  const [viewing, setViewing] = useState<PlatformTenant | null>(null)
  const [name, setName] = useState('')
  const [frequency, setFrequency] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const [t, b, p] = await Promise.all([platformApi.listTenants(), api.get<Backup[]>('/platform/backups'), platformApi.listPlans()]); setTenants(t.data); setBackups(b.data); setPlans(p.data); const counts = await Promise.allSettled(t.data.map(async tenant => { const { data } = await api.get<{ count: number }>(`/platform/backups/tenants/${tenant.id}/module-count`); return [tenant.id, data.count] as const })); setModuleCounts(Object.fromEntries(counts.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))) }
    catch { setError('Unable to load backup information. Please try again.') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function create(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return
    setSaving(true); setError('')
    try { const result = await api.post<Backup>('/platform/backups', { tenant_id: selected.id, name, frequency: frequency || null }, { timeout: 0 }); setSelected(null); setName(''); setFrequency(''); await load(); if (result.data.status === 'failed') setError('The backup failed. Check the server logs for details.') }
    catch { setError('Unable to create the backup. Please try again.') }
    finally { setSaving(false) }
  }
  async function download(backup: Backup) {
    try { const response = await api.get(`/platform/backups/${backup.id}/download`, { responseType: 'blob', timeout: 0 }); saveBlob(response.data, `tenant-${backup.tenant_id}-backup-${backup.id}.sql`) }
    catch { setError('Unable to download this backup.') }
  }

  const planName = (id?: number | null) => plans.find(p => p.id === id)?.name || '—'
  const latestFor = (id: number) => backups.find(b => b.tenant_id === id)
  const availableFor = (id: number) => backups.find(b => b.tenant_id === id && b.status === 'completed' && b.available)
  const backedUp = tenants.filter(t => availableFor(t.id)).length
  const totalStorage = tenants.reduce((sum, t) => sum + Number(t.used_storage ?? 0), 0)

  const rows = useMemo(() => tenants.filter(t => {
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false
    if (statusFilter !== 'all' && t.status !== statusFilter) return false
    if (planFilter !== 'all' && String(t.plan_id) !== planFilter) return false
    const latest = backups.find(b => b.tenant_id === t.id)
    if (backupFilter === 'backed_up' && !backups.some(b => b.tenant_id === t.id && b.status === 'completed' && b.available)) return false
    if (backupFilter === 'none' && latest) return false
    if (backupFilter === 'failed' && latest?.status !== 'failed') return false
    return true
  }), [tenants, backups, search, statusFilter, planFilter, backupFilter])

  const exportList = (format: 'csv' | 'sql') => {
    const header = ['Tenant', 'Status', 'Plan', 'Modules', 'Document storage (MB)', 'Last backup', 'Backup status']
    const lines = rows.map(t => {
      const latest = latestFor(t.id)
      return [t.name, t.status, planName(t.plan_id), moduleCounts[t.id] ?? '', Number(t.used_storage ?? 0).toFixed(2), latest ? asDate(latest.completed_at || latest.created_at).toLocaleString() : '', latest?.status || '']
    })
    const csv = [header, ...lines].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    saveBlob(new Blob([`﻿${csv}`], { type: 'text/csv' }), 'tenant-storage-overview.csv')
  }

  if (viewing) return <ModuleStorageView tenant={viewing} onBack={() => setViewing(null)} />

  const select = 'h-8 w-[125px] rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none focus:border-blue-400'
  const input = 'h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-400'
  const kpis = [
    { label: 'Total tenants', value: tenants.length, icon: Building2, tone: 'bg-blue-50 text-blue-600 ring-blue-100' },
    { label: 'Active tenants', value: tenants.filter(t => t.status === 'active').length, icon: CheckCircle2, tone: 'bg-emerald-50 text-emerald-600 ring-emerald-100' },
    { label: 'Document storage', value: `${totalStorage.toFixed(2)} MB`, icon: Database, tone: 'bg-violet-50 text-violet-600 ring-violet-100' },
    { label: 'Backed up', value: `${backedUp} / ${tenants.length}`, icon: ShieldCheck, tone: 'bg-sky-50 text-sky-600 ring-sky-100' },
  ]

  return <div className="page-body space-y-6">
    <div className="flex items-center justify-between gap-4">
      <div><p className="text-xs text-slate-400">Platform / Backups</p>
      <h2 className="page-title mt-1">Tenant Data Management</h2>
      <p className="page-subtitle">Manage tenant backups, module storage and exports.</p></div>
      <button type="button" onClick={() => void load()} aria-label="Refresh backups" title="Refresh" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
    </div>
    {error && <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</div>}

    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {kpis.map(card => <div key={card.label} className="flex items-start justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{card.label}</p><p className="mt-2 text-2xl font-bold text-slate-900">{card.value}</p></div>
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ${card.tone}`}><card.icon size={19} /></span>
      </div>)}
    </div>

    <section>
      <h3 className="mb-3 text-lg font-bold text-slate-900">Tenant Storage Overview</h3>
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 xl:flex-nowrap">
          <label className="relative w-full sm:w-64"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className="h-8 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100" placeholder="Search tenant name..." value={search} onChange={e => setSearch(e.target.value)} /></label>
          <select aria-label="Filter by status" className={select} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="trial">Trial</option><option value="suspended">Suspended</option><option value="cancelled">Cancelled</option></select>
          <select aria-label="Filter by plan" className={select} value={planFilter} onChange={e => setPlanFilter(e.target.value)}><option value="all">All plans</option>{plans.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}</select>
          <select aria-label="Filter by backup" className={select} value={backupFilter} onChange={e => setBackupFilter(e.target.value)}><option value="all">All backups</option><option value="backed_up">Backed up</option><option value="none">No backup yet</option><option value="failed">Failed</option></select>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative" onKeyDown={event => { if (event.key === 'Escape') setExportOpen(false) }}>
              <button type="button" onClick={() => setExportOpen(open => !open)} disabled={!rows.length} aria-expanded={exportOpen} aria-haspopup="menu" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><Download size={14} /> Export <ChevronDown size={13} /></button>
              {exportOpen && <div role="menu" className="absolute right-0 top-full z-20 mt-2 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"><p className="border-b border-slate-100 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Export overview</p><button type="button" role="menuitem" onClick={() => exportList('csv')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"><FileText size={15} /> Export CSV</button><button type="button" role="menuitem" onClick={() => exportList('sql')} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"><Database size={15} /> Export SQL</button></div>}
            </div>
            <button type="button" onClick={() => { setSearch(''); setStatusFilter('all'); setPlanFilter('all'); setBackupFilter('all') }} className="h-8 shrink-0 rounded-lg px-3 text-xs text-slate-500 hover:bg-red-50 hover:text-red-500">Reset</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-slate-50/60 text-[11px] font-semibold uppercase tracking-wider text-slate-500"><tr>{['Tenant', 'Plan', 'Modules', 'Storage', 'Last backup', 'Status', ''].map((h, i) => <th key={i} className={`px-4 py-3 ${i === 6 ? 'text-right' : ''}`}>{h || 'Action'}</th>)}</tr></thead>
            <tbody>{rows.map(t => {
              const latest = latestFor(t.id)
              const available = availableFor(t.id)
              const when = latest ? asDate(latest.completed_at || latest.created_at) : null
              return <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50/60">
                <td className="px-4 py-3.5"><div className="flex items-center gap-2"><span className="font-semibold text-slate-900">{t.name}</span><span className={`${pill} ${TENANT_STATUS_STYLE[t.status] || TENANT_STATUS_STYLE.cancelled}`}>{t.status}</span></div></td>
                <td className="px-4 py-3.5"><span className={`${pill} bg-sky-50 text-sky-700 ring-sky-200`}>{planName(t.plan_id)}</span></td>
                <td className="px-4 py-3.5 tabular-nums text-slate-700">{moduleCounts[t.id] ?? '?'}</td>
                <td className="px-4 py-3.5"><p className="font-semibold text-slate-800">{Number(t.used_storage ?? 0).toFixed(2)} MB used</p><p className="text-xs text-slate-400">Document storage</p></td>
                <td className="px-4 py-3.5">{when ? <><p className="font-semibold text-slate-800">{when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p><p className="text-xs text-slate-400">{when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {daysAgo(when)}</p></> : <><p className="font-semibold text-slate-400">No backup yet</p><p className="text-xs text-slate-400">Back up to protect data</p></>}</td>
                <td className="px-4 py-3.5">{latest ? <span className={`${pill} ${BACKUP_STATUS_STYLE[latest.status] || BACKUP_STATUS_STYLE.pending}`}>{latest.status.replace('_', ' ')}</span> : <span className="text-slate-300">—</span>}</td>
                <td className="px-4 py-3.5"><div className="flex items-center justify-end gap-2">
                  <button type="button" onClick={() => setSelected(t)} title="Create backup" aria-label={`Back up ${t.name}`} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-blue-600 hover:bg-blue-50"><HardDrive size={15} /></button>
                  {available && <button type="button" onClick={() => void download(available)} title="Download latest backup" aria-label={`Download backup for ${t.name}`} className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-600 hover:bg-slate-50"><Download size={15} /></button>}
                  <button type="button" onClick={() => setViewing(t)} className="inline-flex h-8 items-center gap-1 rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:border-blue-300 hover:text-blue-700">View <ChevronRight size={14} /></button>
                </div></td>
              </tr>
            })}</tbody>
          </table>
          {!loading && rows.length === 0 && <p className="p-8 text-center text-sm text-slate-400">{tenants.length ? 'No tenants match these filters.' : 'No tenants available.'}</p>}
        </div>
      </div>
    </section>

    {selected && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4"><form onSubmit={create} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><div className="flex justify-between"><h3 className="text-lg font-bold">Back up {selected.name}</h3><button type="button" disabled={saving} onClick={() => setSelected(null)} aria-label="Close"><X size={20} /></button></div><label className="mt-5 block text-sm font-medium">Backup name <span className="text-slate-400">(optional)</span><input className={`${input} mt-2 w-full`} maxLength={200} value={name} onChange={e => setName(e.target.value)} /></label><label className="mt-4 block text-sm font-medium">Schedule<select className={`${input} mt-2 w-full`} value={frequency} onChange={e => setFrequency(e.target.value)}><option value="">Immediate backup</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Every 30 days</option></select></label><p className="mt-2 text-xs text-slate-500">Scheduled backups also create a copy immediately.</p><div className="mt-6 flex justify-end gap-2"><button type="button" disabled={saving} onClick={() => setSelected(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm">Cancel</button><button disabled={saving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Creating backup...' : 'Create backup'}</button></div></form></div>}
  </div>
}

function ModuleStorageView({ tenant, onBack }: { tenant: PlatformTenant; onBack: () => void }) {
  const [data, setData] = useState<ModuleStorage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<'sql' | 'csv' | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    setLoading(true); setError('')
    api.get<ModuleStorage>(`/platform/backups/tenants/${tenant.id}/modules`, { timeout: 0 })
      .then(({ data }) => setData(data))
      .catch(() => setError('Unable to load module storage for this tenant.'))
      .finally(() => setLoading(false))
  }, [tenant.id])

  const modules = data?.modules ?? []
  const toggle = (key: string) => setPicked(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next })

  // With nothing ticked, the export covers every module.
  const exportKeys = picked.size ? [...picked] : modules.map(m => m.key)

  async function exportSelected() {
    if (!format) return
    setExporting(true); setError('')
    try {
      const response = await api.post(`/platform/backups/tenants/${tenant.id}/export`, { modules: exportKeys, format }, { responseType: 'blob', timeout: 0 })
      const match = /filename="?([^";]+)"?/.exec(response.headers['content-disposition'] || '')
      saveBlob(response.data, match?.[1] || `${tenant.slug}-modules.${format === 'sql' ? 'sql' : 'zip'}`)
    } catch {
      setError('Export failed. Please try again.')
    } finally { setExporting(false) }
  }

  return <div className="page-body">
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-slate-500"><button type="button" onClick={onBack} className="hover:text-slate-800">Backups</button><ChevronRight size={12} className="text-slate-300" /><span aria-current="page" className="font-medium text-slate-700">{tenant.name}</span></nav>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 ring-1 ring-blue-100"><Database size={19} /></span>
          <div><h2 className="text-xl font-bold text-slate-900">{tenant.name} — Module Storage</h2><p className="mt-0.5 text-sm text-slate-500">Select the modules to export</p></div>
        </div>
        {data && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-600">{formatBytes(data.total_bytes)}</span>}
      </div>

      {error && <div role="alert" className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {loading ? <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400"><Loader2 size={18} className="animate-spin" /> Reading tenant database...</div> : modules.length > 0 && <>
        <div className="mt-6 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-800">{picked.size} of {modules.length} selected</p>
          <div className="flex gap-4 text-sm">
            <button type="button" onClick={() => setPicked(new Set(modules.map(m => m.key)))} disabled={picked.size === modules.length} className="font-medium text-blue-600 hover:text-blue-800 disabled:text-slate-300">Select all</button>
            <button type="button" onClick={() => setPicked(new Set())} disabled={!picked.size} className="font-medium text-slate-500 hover:text-slate-800 disabled:text-slate-300">Clear</button>
          </div>
        </div>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-[11px] font-semibold uppercase tracking-wider text-slate-500"><tr className="border-b border-slate-100"><th className="w-12 py-3" /><th className="py-3">Module</th><th className="py-3">Records</th><th className="py-3">Storage</th></tr></thead>
          <tbody>{modules.map(m => {
            const on = picked.has(m.key)
            return <tr key={m.key} onClick={() => toggle(m.key)} className={`cursor-pointer border-b border-slate-100 transition-colors ${on ? 'bg-blue-50/60' : 'hover:bg-slate-50'}`}>
              <td className="py-3 pl-2"><span role="checkbox" aria-checked={on} aria-label={m.label} className={`flex h-5 w-5 items-center justify-center rounded-full border-2 ${on ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white'}`}>{on && <Check size={12} strokeWidth={3} />}</span></td>
              <td className="py-3"><p className="font-semibold text-slate-900">{m.label}</p><p className="text-xs text-slate-400">{m.table_count} table{m.table_count === 1 ? '' : 's'}</p></td>
              <td className="py-3 tabular-nums text-slate-700">{m.records.toLocaleString()}</td>
              <td className="py-3 tabular-nums text-slate-700">{formatBytes(m.storage_bytes)}</td>
            </tr>
          })}</tbody>
        </table>

        <div className="mt-6 border-t border-slate-100 pt-5">
          <p className="text-sm font-semibold text-slate-800">Export format</p>
          <div className="mt-3 flex gap-6">
            {([['sql', 'SQL'], ['csv', 'CSV (ZIP)']] as const).map(([value, label]) => <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700"><input type="radio" name="export-format" value={value} checked={format === value} onChange={() => setFormat(value)} className="h-4 w-4 accent-blue-600" />{label}</label>)}
          </div>
          <p className="mt-2 text-xs text-slate-500">{format === 'sql' ? "A restorable SQL dump of the selected modules' tables." : format === 'csv' ? 'One CSV file per table, packed into a ZIP archive.' : 'Choose a format to enable export.'}</p>
          <div className="mt-5 flex items-center justify-end gap-3">
            <span className="text-xs text-slate-500">{picked.size ? `${picked.size} module${picked.size === 1 ? '' : 's'}` : `All ${modules.length} modules`}</span>
            <button type="button" onClick={() => void exportSelected()} disabled={!format || exporting} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {exporting ? 'Exporting...' : picked.size ? 'Export selected' : 'Export all'}</button>
          </div>
        </div>
      </>}
      {!loading && !error && modules.length === 0 && <p className="py-12 text-center text-sm text-slate-400">No tables found in this tenant database.</p>}
    </div>
  </div>
}
