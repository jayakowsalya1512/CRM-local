import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { RefreshCw, Search, ChevronDown, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight, Eye, X } from 'lucide-react'
import { platformApi, PlatformAuditEntry, TenantAuditEntry } from '@/services/platformApi'
import { Card } from '@/components/ui/Card'
import { useToast } from '@/components/ui/FormComponents'

const ACTION_COLORS: Record<string, string> = {
  create_tenant: 'badge-success',
  update_tenant: 'badge-primary',
  suspend_tenant: 'badge-danger',
  reactivate_tenant: 'badge-success',
  force_logout: 'badge-warning',
  create_plan: 'badge-success',
  update_plan_features: 'badge-primary',
  create_super_admin: 'badge-success',
  update_super_admin: 'badge-primary',
  deactivate_super_admin: 'badge-danger',
  activate_super_admin: 'badge-success',
}

function formatTs(iso: string) {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    })
  } catch {
    return iso
  }
}

function DataToggle({ data }: { data: Record<string, unknown> | null | undefined }) {
  const [open, setOpen] = useState(false)
  if (!data || Object.keys(data).length === 0) return <span className="text-slate-400 text-xs">—</span>
  return (
    <div>
      <button
        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {open ? 'Hide' : 'View'} data
      </button>
      {open && (
        <pre className="mt-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto max-w-xs">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}

    </div>
  )
}

export default function PlatformAuditLogPage() {
  const { id: tenantIdParam } = useParams<{ id?: string }>()
  const tenantId = tenantIdParam ? Number(tenantIdParam) : null
  const isTenantView = Boolean(tenantId)

  const { error: showError } = useToast()
  const [viewing, setViewing] = useState<PlatformAuditEntry | null>(null)
  const [platformLogs, setPlatformLogs] = useState<PlatformAuditEntry[]>([])
  const [platformTotal, setPlatformTotal] = useState(0)
  const [entityTypes, setEntityTypes] = useState<string[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const [tenantLogs, setTenantLogs] = useState<TenantAuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [entityFilter, setEntityFilter] = useState('all')
  const [actionFilter, setActionFilter] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [jumpPage, setJumpPage] = useState('1')
  useEffect(() => setPage(1), [search, entityFilter, actionFilter, fromDate, toDate, pageSize, tenantId])

  const load = async () => {
    setLoading(true)
    try {
      if (isTenantView && tenantId) {
        const { data } = await platformApi.getTenantAuditLogs(tenantId, 500)
        setTenantLogs(data)
      }
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to load audit logs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (isTenantView) void load() }, [tenantId, refreshKey])
  useEffect(() => {
    if (isTenantView) return
    let active = true
    setLoading(true)
    platformApi.listAuditLogPage({
      page, page_size: pageSize, search: search || undefined,
      entity_type: entityFilter === 'all' ? undefined : entityFilter,
      action: actionFilter === 'all' ? undefined : actionFilter,
      date_from: fromDate || undefined, date_to: toDate || undefined,
    }).then(({ data }) => {
      if (!active) return
      setPlatformLogs(data.items)
      setPlatformTotal(data.total)
      setEntityTypes(data.entity_types)
      setActions(data.actions)
    }).catch((err) => {
      if (active) showError(err?.response?.data?.detail || 'Unable to load audit logs')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [isTenantView, page, pageSize, search, entityFilter, actionFilter, fromDate, toDate, refreshKey])

  // Tenant log filters
  const tenantActions = Array.from(new Set(tenantLogs.map((l) => l.action))).sort()
  const tenantModules = Array.from(new Set(tenantLogs.map((l) => l.module))).sort()

  const filteredTenant = tenantLogs.filter((log) => {
    const q = search.toLowerCase()
    const matchesSearch =
      !q ||
      (log.description || '').toLowerCase().includes(q) ||
      (log.user_name || '').toLowerCase().includes(q) ||
      (log.ip_address || '').includes(q)
    const matchesEntity = entityFilter === 'all' || log.module === entityFilter
    const matchesAction = actionFilter === 'all' || log.action === actionFilter
    const date = log.created_at?.slice(0, 10) || ''
    return matchesSearch && matchesEntity && matchesAction && (!fromDate || date >= fromDate) && (!toDate || date <= toDate)
  })

  const totalRows = isTenantView ? filteredTenant.length : platformTotal
  const effectivePageSize = pageSize || Math.max(totalRows, 1)
  const totalPages = Math.max(1, Math.ceil(totalRows / effectivePageSize))
  const currentPage = Math.min(page, totalPages)
  useEffect(() => { if (!loading && page > totalPages) setPage(totalPages) }, [loading, page, totalPages])
  const start = (currentPage - 1) * effectivePageSize
  useEffect(() => setJumpPage(String(currentPage)), [currentPage])
  const visiblePages = Array.from(new Set([1, ...[currentPage - 1, currentPage, currentPage + 1].filter(n => n > 1 && n < totalPages), totalPages])).sort((a, b) => a - b)

  return (
    <div className="page-body space-y-5">
      <div className="flex items-center justify-between">
        <div>
          {isTenantView && (
            <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-xs text-slate-500"><Link to="/platform/tenants" className="hover:text-slate-800">Tenants</Link><ChevronRight size={12} className="text-slate-300" /><span aria-current="page" className="font-medium text-slate-700">Audit Log</span></nav>
          )}
          <h2 className="page-title">{isTenantView ? 'Tenant Audit Log' : 'Platform Audit Log'}</h2>
          <p className="page-subtitle">
            {isTenantView
              ? 'Read-only history of actions performed inside this tenant'
              : 'Read-only history of all platform-level actions'}
          </p>
        </div>
        <button type="button" aria-label="Refresh audit logs" title="Refresh" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600" onClick={() => setRefreshKey(v => v + 1)}>
          <RefreshCw size={15} />
        </button>
      </div>

      <Card className="-mx-1 sm:-mx-3">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-slate-100 p-4 xl:flex-nowrap">
        <div className="relative min-w-[200px] flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            placeholder={isTenantView ? 'Search by user, description, IP...' : 'Search by name, description, IP...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex min-w-0 items-center gap-2">

          <select
            className="h-9 w-[145px] rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 outline-none focus:border-blue-400"
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
          >
            <option value="all">{isTenantView ? 'All modules' : 'All entities'}</option>
            {(isTenantView ? tenantModules : entityTypes).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select
            className="h-9 w-[145px] rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-600 outline-none focus:border-blue-400"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="all">All actions</option>
            {(isTenantView ? tenantActions : actions).map((a) => (
              <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>
            ))}
          </select>
        </div>
        <input aria-label="From date" type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9 w-[145px] shrink-0 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none focus:border-blue-400" />
        <span className="text-sm text-slate-400">to</span>
        <input aria-label="To date" type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9 w-[145px] shrink-0 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-600 outline-none focus:border-blue-400" />
        <button type="button" onClick={() => { setSearch(''); setEntityFilter('all'); setActionFilter('all'); setFromDate(''); setToDate('') }} className="h-9 shrink-0 rounded-lg px-3 text-xs text-slate-500 hover:bg-red-50 hover:text-red-500">Reset</button>
      </div>

      {/* Platform-level audit log table */}
      {!isTenantView && (
        <>
          {loading ? (
            <div className="p-8 flex justify-center"><div className="loading-spinner" /></div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto overflow-x-hidden">
              <table className="w-full table-fixed text-left text-xs sm:text-sm [&_th]:break-words [&_th]:px-1 [&_th]:py-3 [&_th]:font-semibold [&_td]:px-1 [&_td]:py-3 sm:[&_th]:px-2 sm:[&_td]:px-2 [&_td]:align-middle [&_tr:hover]:bg-slate-50">
                <colgroup>
                  <col style={{ width: '14%' }} /><col style={{ width: '10%' }} /><col style={{ width: '15%' }} />
                  <col style={{ width: '8%' }} /><col style={{ width: '10%' }} /><col style={{ width: '20%' }} />
                  <col style={{ width: '11%' }} /><col style={{ width: '6%' }} /><col style={{ width: '6%' }} />
                </colgroup>
                <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="!pl-5">Date &amp; Time</th><th>Admin/User</th><th>Action</th><th>Tenant</th><th>Entity</th><th>Record / Reference</th><th>IP Address</th><th>Status</th><th className="text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {platformLogs.map((log) => (
                    <tr key={log.id} className="cursor-pointer" onClick={() => setViewing(log)}>
                      <td className="!pl-5 break-words text-xs text-slate-500">{formatTs(log.created_at)}</td>
                      <td className="truncate text-slate-700" title={log.performed_by || 'System'}>{log.performed_by || 'System'}</td>
                      <td className="break-words text-slate-800">{log.action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</td>
                      <td className="break-words text-slate-500">{log.entity_type === 'tenant' ? (log.entity_name || (log.entity_id != null ? String(log.entity_id) : '?')) : '?'}</td>
                      <td><span className="inline-block max-w-full break-words rounded-full bg-blue-50 px-2 py-1 text-xs text-blue-700">{log.entity_type.replace(/_/g, ' ')}</span></td>
                      <td className="text-slate-500"><span className="block truncate" title={String(log.entity_name || log.entity_id || '?')}>{log.entity_name || log.entity_id || '?'}</span></td>
                      <td className="break-all font-mono text-xs text-slate-500">{log.ip_address || '?'}</td>
                      <td className="text-slate-400">?</td>
                      <td className="text-center"><button type="button" aria-label="View audit details" onClick={e => { e.stopPropagation(); setViewing(log) }} className="rounded-lg p-1 text-slate-500 hover:bg-blue-50 hover:text-blue-600"><Eye size={16} /></button></td>
                    </tr>
                  ))}
                  {!platformLogs.length && <tr><td colSpan={9}><div className="empty-state py-12"><p>No audit events found</p></div></td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Tenant-level audit log table */}
      {isTenantView && (
        <>
          {loading ? (
            <div className="p-8 flex justify-center"><div className="loading-spinner" /></div>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full min-w-[1000px] table-fixed text-left text-sm [&_th]:px-4 [&_th]:py-3 [&_th]:font-semibold [&_td]:px-4 [&_td]:py-3 [&_tr:hover]:bg-slate-50">
                <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th>Timestamp</th>
                    <th>Module</th>
                    <th>Action</th>
                    <th>Description</th>
                    <th>User</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredTenant.slice(start, start + effectivePageSize).map((log) => (
                    <tr key={log.id}>
                      <td className="text-xs text-slate-500 whitespace-nowrap">{formatTs(log.created_at)}</td>
                      <td>
                        <span className="badge badge-gray">{log.module}</span>
                      </td>
                      <td>
                        <span className={`badge ${log.action === 'delete' ? 'badge-danger' : log.action === 'create' ? 'badge-success' : 'badge-primary'}`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="text-sm text-slate-600 max-w-xs">{log.description || '—'}</td>
                      <td className="text-sm">{log.user_name || <span className="text-slate-400">—</span>}</td>
                      <td className="text-xs text-slate-500 font-mono">{log.ip_address || '—'}</td>
                    </tr>
                  ))}
                  {!filteredTenant.length && (
                    <tr><td colSpan={6}><div className="empty-state py-12"><p>No audit events found</p></div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!loading && <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-slate-100 bg-slate-50/40 px-4 py-2 text-[11px] text-slate-500">
        <span className="font-medium">{totalRows ? `${start + 1}–${Math.min(start + effectivePageSize, totalRows)} of ${totalRows} records` : '0 records'}</span>
        <span className="hidden h-5 w-px bg-slate-200 sm:block" />
        <div className="flex items-center gap-2"><span>Rows per page:</span><div className="flex overflow-hidden rounded-lg border border-slate-200 bg-white">
          {[10, 25, 50, 100].map(n => <button key={n} type="button" onClick={() => setPageSize(n)} className={`border-r border-slate-200 px-2.5 py-1 ${pageSize === n ? 'bg-slate-900 font-semibold text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{n}</button>)}
          <button type="button" onClick={() => setPageSize(0)} className={`px-2.5 py-1 ${pageSize === 0 ? 'bg-slate-900 font-semibold text-white' : 'text-slate-600 hover:bg-slate-50'}`}>All</button>
        </div></div>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" aria-label="First page" disabled={currentPage === 1} onClick={() => setPage(1)} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronsLeft size={13} /></button>
          <button type="button" aria-label="Previous page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronLeft size={13} /></button>
          {visiblePages.map((n, i) => <span key={n} className="flex items-center">{i > 0 && n - visiblePages[i - 1] > 1 && <span className="px-1">…</span>}<button type="button" aria-label={`Page ${n}`} aria-current={n === currentPage ? 'page' : undefined} onClick={() => setPage(n)} className={`flex h-7 min-w-7 text-[11px] items-center justify-center rounded-lg px-2 ${n === currentPage ? 'bg-slate-900 font-semibold text-white shadow-sm' : 'hover:bg-slate-100'}`}>{n}</button></span>)}
          <button type="button" aria-label="Next page" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronRight size={13} /></button>
          <button type="button" aria-label="Last page" disabled={currentPage === totalPages} onClick={() => setPage(totalPages)} className="flex h-7 w-7 items-center justify-center rounded-lg hover:bg-slate-100 disabled:opacity-30"><ChevronsRight size={13} /></button>
          <span className="mx-2 h-5 w-px bg-slate-200" /><label className="flex items-center gap-2">Go to <input aria-label="Go to page" type="number" min="1" max={totalPages} value={jumpPage} onChange={e => setJumpPage(e.target.value)} onBlur={() => { const n = Math.min(totalPages, Math.max(1, Number(jumpPage) || 1)); setPage(n); setJumpPage(String(n)) }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} className="h-7 w-12 rounded-md border border-slate-200 bg-white px-2 text-slate-700" /></label>
        </div>
      </div>}
      </Card>
      {viewing && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onClick={() => setViewing(null)}>
        <div role="dialog" aria-modal="true" aria-labelledby="audit-details-title" className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between"><h3 id="audit-details-title" className="text-lg font-semibold text-slate-900">Audit Entry Details</h3><button type="button" aria-label="Close details" onClick={() => setViewing(null)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={18} /></button></div>
          <p className="mt-4 text-sm text-slate-600">{viewing.description || 'No description available.'}</p>
          <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2"><div><p className="text-slate-400">Before</p><DataToggle data={viewing.old_data} /></div><div><p className="text-slate-400">After</p><DataToggle data={viewing.new_data} /></div></div>
        </div>
      </div>}
    </div>
  )
}

