import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, MoreHorizontal, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react'
import { PageHeader, StatCard } from '@/components/ui/FormComponents'
import { usePermissions } from '@/hooks/Usepermissions'
import { recycleBinApi, type RecycleBinItem, type RecycleBinResponse } from '@/services/api'
import { formatDateTimeValue } from '@/utils/date'
import { useToast } from '@/components/ui/ToastContext'
import { confirmAction } from '@/utils/sweetAlert'

const MODULE_COLORS: Record<string, string> = {
  customers: 'bg-blue-50 text-blue-700',
  leads: 'bg-violet-50 text-violet-700',
  opportunities: 'bg-purple-50 text-purple-700',
  tenders: 'bg-amber-50 text-amber-700',
  oems: 'bg-emerald-50 text-emerald-700',
  document_management: 'bg-cyan-50 text-cyan-700',
  letter_management: 'bg-rose-50 text-rose-700',
}
const moduleBadgeColor = (moduleKey: string) => MODULE_COLORS[moduleKey] || 'bg-slate-100 text-slate-600'

export default function RecycleBinPage() {
  const { can } = usePermissions()
  const { success, error } = useToast()
  const [data, setData] = useState<RecycleBinResponse | null>(null)
  const [view, setView] = useState<'deleted' | 'restored'>('deleted')
  const [module, setModule] = useState('')
  const [search, setSearch] = useState('')
  const [actor, setActor] = useState('')
  const [rangeDays, setRangeDays] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [limit, setLimit] = useState(25)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const sequence = useRef(0)
  const canRestore = can('recycle_bin.restore')
  const canDelete = can('recycle_bin.delete')
  const selectable = view === 'deleted' && (canRestore || canDelete)
  const toISODate = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  const dateFrom = rangeDays ? (() => { const start = new Date(); start.setDate(start.getDate() - (rangeDays - 1)); return toISODate(start) })() : undefined
  const dateTo = rangeDays ? toISODate(new Date()) : undefined

  useEffect(() => {
    const id = ++sequence.current
    setLoading(true)
    setSelected(new Set())
    const timer = window.setTimeout(async () => {
      try {
        const response = await recycleBinApi.list({ module: module || undefined, search: search.trim() || undefined,
          view, page, limit, deleted_by: actor ? Number(actor) : undefined, date_from: dateFrom, date_to: dateTo })
        if (id !== sequence.current) return
        setData(response.data)
        setPage(response.data.page)
      } catch (err: any) {
        if (id === sequence.current) { setData(null); error(err?.response?.data?.detail || 'Unable to load recycle bin') }
      } finally { if (id === sequence.current) setLoading(false) }
    }, search ? 250 : 0)
    return () => { window.clearTimeout(timer); sequence.current += 1 }
  }, [module, search, view, page, limit, actor, dateFrom, dateTo, refresh])

  const change = (setter: (value: string) => void, value: string) => { setter(value); setPage(1) }
  const switchView = (value: 'deleted' | 'restored') => { setView(value); setModule(''); setPage(1); setActor('') }
  const clearFilters = () => { setSearch(''); setActor(''); setRangeDays(null); setPage(1) }
  const act = async (action: 'restore' | 'delete', rows: RecycleBinItem[], bulk = false) => {
    if (busy || loading || !rows.length) return
    if ((action === 'delete' || bulk) && !await confirmAction({
      title: action === 'delete' ? 'Permanently delete records?' : 'Restore records?',
      text: `${rows.length === 1 ? rows[0].title : `${rows.length} selected records`}${action === 'delete' ? ' will be permanently removed. This cannot be undone.' : ' will be restored.'}`,
      confirmButtonText: action === 'delete' ? 'Delete permanently' : 'Restore', icon: 'warning',
    })) return
    setBusy(true)
    try {
      if (bulk) {
        const { data: result } = await recycleBinApi.bulk(action, rows.map(({ module_key, record_id }) => ({ module_key, record_id })))
        const failed = result.results.filter(item => !item.success)
        const count = result.results.length - failed.length
        if (count) success(`${count} records ${action === 'restore' ? 'restored' : 'permanently deleted'}`)
        if (failed.length) error(failed.map(item => `${item.module_key} #${item.record_id}: ${item.error}`).join('; '))
      } else {
        const item = rows[0]
        if (action === 'restore') await recycleBinApi.restore(item.module_key, item.record_id)
        else await recycleBinApi.deletePermanently(item.module_key, item.record_id)
        success(action === 'restore' ? 'Record restored' : 'Record permanently deleted')
      }
    } catch (err: any) { error(err?.response?.data?.detail || 'Operation failed') }
    finally { setBusy(false); setSelected(new Set()); setRefresh(value => value + 1) }
  }
  const rows = data?.items || []
  const deletedTotal = Object.values(data?.counts || {}).reduce((sum, count) => sum + count, 0)
  const counts = view === 'deleted' ? data?.counts : data?.restored_counts
  const deletedItemsValue = module ? (data?.counts?.[module] || 0) : deletedTotal
  const restoredValue = module ? (data?.restored_counts?.[module] || 0) : (data?.restored_count || 0)
  const total = data?.total || 0
  const pages = Math.max(1, Math.ceil(total / limit))
  const pageNumbers = useMemo(() => {
    const range: (number | '...')[] = []
    const delta = 2
    const left = Math.max(2, page - delta)
    const right = Math.min(pages - 1, page + delta)
    range.push(1)
    if (left > 2) range.push('...')
    for (let i = left; i <= right; i++) range.push(i)
    if (right < pages - 1) range.push('...')
    if (pages > 1) range.push(pages)
    return range
  }, [page, pages])
  const startRow = total === 0 ? 0 : (page - 1) * limit + 1
  const endRow = Math.min(page * limit, total)
  const date = (value?: string | null) => value ? formatDateTimeValue(value, { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not recorded'
  const dateOnly = (value?: string | null) => value ? formatDateTimeValue(value, { day: '2-digit', month: 'short', year: 'numeric' }) : 'Not available'
  const button = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium disabled:opacity-40 hover:bg-slate-50'
  const input = 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm'
  const iconButton = 'flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-40'
  const columnCount = (selectable ? 1 : 0) + 6

  return <div className="page-body space-y-5">
    <PageHeader title="Recycle Bin" subtitle="Review deleted records, restore them, or permanently remove them." actions={
      <button className={button} aria-label="Refresh" disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
    } />
    <div className="inline-flex w-fit flex-wrap gap-1 rounded-xl bg-slate-100 p-1" aria-label="Module filters">
      {[{ key: '', label: 'All' }, ...(data?.modules || [])].map(item => <button key={item.key} aria-pressed={module === item.key}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${module === item.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
        onClick={() => change(setModule, item.key)}>{item.label} ({item.key ? counts?.[item.key] || 0 : view === 'deleted' ? deletedTotal : data?.restored_count || 0})</button>)}
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <StatCard title={module ? `Deleted Items · ${data?.modules.find(item => item.key === module)?.label || ''}` : 'Deleted Items'} value={deletedItemsValue} icon={<Trash2 size={18} />} active={view === 'deleted'} onClick={() => switchView('deleted')} />
      <StatCard title={module ? `Restored · ${data?.modules.find(item => item.key === module)?.label || ''}` : 'Restored'} value={restoredValue} icon={<RotateCcw size={18} />} active={view === 'restored'} onClick={() => switchView('restored')} />
    </div>
    <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-4">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-slate-500">Search<input className={input} value={search} placeholder={`Search ${view} records`} onChange={event => change(setSearch, event.target.value)} /></label>
        <label className="flex w-48 flex-col gap-1 text-xs text-slate-500">{view === 'deleted' ? 'Deleted By' : 'Restored By'}
          <select className={input} value={actor} onChange={event => change(setActor, event.target.value)}><option value="">All users</option>{data?.actors.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        </label>
        <label className="flex w-44 flex-col gap-1 text-xs text-slate-500">Date range
          <select className={input} value={rangeDays ?? ''} onChange={event => { setRangeDays(event.target.value ? Number(event.target.value) : null); setPage(1) }}>
            <option value="">All time</option>
            <option value={7}>Last week</option>
            <option value={10}>Last 10 days</option>
            <option value={15}>Last 15 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </label>
        <button type="button" onClick={clearFilters}
          className="inline-flex h-9 flex-none items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500">
          <X size={12} /> Reset
        </button>
      </div>
      {selectable && selected.size > 0 && <div className="flex items-center gap-3 border-b bg-blue-50 p-3 text-sm">
        <span>{selected.size} selected on this page</span>
        {canRestore && <button className={button} disabled={busy || loading} onClick={() => void act('restore', rows.filter(item => selected.has(item.id)), true)}>Restore selected</button>}
        {canDelete && <button className={`${button} text-red-600`} disabled={busy || loading} onClick={() => void act('delete', rows.filter(item => selected.has(item.id)), true)}>Permanently delete selected</button>}
      </div>}
      <div className="max-h-[60vh] overflow-auto" aria-busy={loading || busy}>
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            {selectable && <col className="w-10" />}
            <col className="w-[20%]" />
            <col className="w-[12%]" />
            <col className="w-[26%]" />
            <col className="w-[18%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
          </colgroup>
          <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr>
            {selectable && <th className="px-4 py-3 text-center"><input type="checkbox" aria-label="Select all records on this page" disabled={loading || busy} checked={rows.length > 0 && selected.size === rows.length} onChange={event => setSelected(event.target.checked ? new Set(rows.map(item => item.id)) : new Set())} /></th>}
            <th className="px-4 py-3 font-semibold">Record</th>
            <th className="px-4 py-3 font-semibold">Module</th>
            <th className="px-4 py-3 font-semibold">Record Timeline</th>
            <th className="px-4 py-3 font-semibold">{view === 'deleted' ? 'Deleted' : 'Restored at'}</th>
            <th className="px-4 py-3 font-semibold">{view === 'deleted' ? 'Deleted By' : 'Restored By'}</th>
            <th className="px-4 py-3 text-right font-semibold">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? <tr><td colSpan={columnCount} className="p-10 text-center text-slate-500">Loading records…</td></tr> : rows.length === 0 ? <tr><td colSpan={columnCount} className="p-10 text-center text-slate-500">No {view} records match these filters.</td></tr> : rows.map(item => <tr key={item.id} className="align-middle hover:bg-slate-50">
              {selectable && <td className="px-4 py-3 text-center"><input aria-label={`Select ${item.title}`} type="checkbox" disabled={busy} checked={selected.has(item.id)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next })} /></td>}
              <td className="px-4 py-3"><p className="truncate font-semibold text-slate-800" title={item.title}>{item.title}</p>{item.subtitle && <p className="truncate text-xs text-slate-500" title={item.subtitle}>{item.subtitle}</p>}</td>
              <td className="px-4 py-3"><span className={`inline-block truncate rounded-full px-2.5 py-1 text-xs font-medium ${moduleBadgeColor(item.module_key)}`}>{item.module_label}</span></td>
              <td className="px-4 py-3 text-xs text-slate-500">
                <p className="truncate">Created: <span className="font-medium text-slate-700">{dateOnly(item.created_at)}</span></p>
                <p className="truncate">Updated: <span className="font-medium text-slate-700">{dateOnly(item.updated_at)}</span></p>
              </td>
              <td className="px-4 py-3 text-slate-600">{date(item.deleted_at)}</td>
              <td className="px-4 py-3 text-slate-600"><span className="truncate">{item.deleted_by_name || '-'}</span></td>
              <td className="px-4 py-3"><div className="flex items-center justify-end gap-2">
                {view === 'restored' ? <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><CheckCircle2 size={14} /> Restored</span> : <>
                  {canRestore && <button title="Restore" aria-label="Restore" className={`${iconButton} border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100`} disabled={busy} onClick={() => void act('restore', [item])}><RotateCcw size={14} /></button>}
                  {canDelete && <button title="Permanently delete" aria-label="Permanently delete" className={`${iconButton} border-red-200 bg-red-50 text-red-600 hover:bg-red-100`} disabled={busy} onClick={() => void act('delete', [item])}><Trash2 size={14} /></button>}
                  {!canRestore && !canDelete && <span className="text-xs text-slate-500">View only</span>}
                </>}
              </div></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-3 border-t border-slate-100 bg-slate-50/40 px-5 py-3 text-xs text-slate-500 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{total === 0 ? 'No records' : `${startRow}–${endRow} of ${total} record${total !== 1 ? 's' : ''}`}</span>
          <div className="hidden h-3 w-px bg-slate-300 sm:block" />
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Rows per page:</span>
            <div className="flex divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200">
              {[10, 25, 50, 100].map(value => <button key={value} onClick={() => { setLimit(value); setPage(1) }}
                className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${limit === value ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}>{value}</button>)}
            </div>
          </div>
        </div>
        {total > 0 && <div className="flex items-center gap-1 sm:ml-auto">
          <button onClick={() => setPage(1)} disabled={loading || busy || page === 1} title="First page"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30"><ChevronsLeft size={14} /></button>
          <button onClick={() => setPage(value => Math.max(1, value - 1))} disabled={loading || busy || page === 1} title="Previous page"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft size={14} /></button>
          {pageNumbers.map((value, index) => value === '...'
            ? <span key={`dots-${index}`} className="flex h-8 w-8 items-center justify-center text-slate-400"><MoreHorizontal size={14} /></span>
            : <button key={value} disabled={loading || busy} onClick={() => setPage(value)}
                className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-semibold transition-all ${page === value ? 'scale-105 bg-blue-600 text-white shadow-sm shadow-blue-200' : 'text-slate-600 hover:bg-slate-100'}`}>{value}</button>)}
          <button onClick={() => setPage(value => Math.min(pages, value + 1))} disabled={loading || busy || page === pages} title="Next page"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight size={14} /></button>
          <button onClick={() => setPage(pages)} disabled={loading || busy || page === pages} title="Last page"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30"><ChevronsRight size={14} /></button>
          <div className="ml-2 flex items-center gap-1.5 border-l border-slate-200 pl-2">
            <span className="text-slate-400">Go to</span>
            <input type="number" min={1} max={pages} key={page} defaultValue={page} disabled={loading || busy}
              onBlur={event => { const value = parseInt(event.target.value); if (value >= 1 && value <= pages) setPage(value) }}
              onKeyDown={event => { if (event.key === 'Enter') { const value = parseInt((event.target as HTMLInputElement).value); if (value >= 1 && value <= pages) setPage(value) } }}
              className="w-12 rounded-lg border border-slate-200 px-2 py-1 text-center text-xs focus:border-blue-400 focus:outline-none" />
          </div>
        </div>}
      </div>
    </div>
  </div>
}
