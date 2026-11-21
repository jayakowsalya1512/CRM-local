import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Clock,
  Download,
  Play,
  Receipt,
  RefreshCw,
  Save,
  Share2,
  Trash2,
  Wallet,
  X,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { ReportToolbarCtx } from './reportToolbarContext'
import { reportsApi } from '@/services/api'
import { DataTable, StatusBadge, type Column } from '@/components/ui/DataTable'
import { useToast } from '@/components/ui/FormComponents'
import { KpiCard, ReportActionsMenu, SaveModal, fmtCur, fmtNum } from './reportViewShared'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useReportFilters } from './shared/useReportFilters'
import { ReportFilterBar } from './shared/ReportFilterBar'
import { TADA_FILTER_CONFIG } from './shared/filterConfigs'
import type { FilterOptionsMap } from './shared/filterTypes'
import { ListDrilldownModal, ListDrilldownRequest } from './shared/ListDrilldownModal'
import type { ColDef } from '../dashboard/tabs/_shared'

interface SavedView {
  id: number
  name: string
  filters: Record<string, string>
  is_shared: boolean
  is_mine: boolean
  created_by_name: string
}

const toApiParams = (applied: Record<string, string>, extra: Record<string, unknown> = {}) => {
  const p: Record<string, unknown> = { ...extra }
  for (const [k, v] of Object.entries(applied)) {
    if (!v) continue
    if ((k === 'date_from' || k === 'date_to') && applied.preset !== 'custom') continue
    p[k] = v
  }
  return p
}

function shortCurrency(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 1e7) return `${(n / 1e7).toFixed(1)}Cr`
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)}L`
  return `${Math.round(n / 1000)}k`
}

const ChartTip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-gray-800">{label}</p>
      {payload.map((entry: any) => (
        <p key={entry.dataKey} style={{ color: entry.color }} className="font-medium">
          {entry.dataKey.includes('amount') || entry.dataKey === 'claimed' || entry.dataKey === 'payable'
            ? fmtCur(entry.value)
            : entry.value}
        </p>
      ))}
    </div>
  )
}

const ScatterTip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-gray-800">{row.employee}</p>
      <p className="text-gray-500">Claim #{row.label}</p>
      <p className="text-blue-700">Settlement: {row.days} days</p>
      <p className="text-emerald-700">Payable: {fmtCur(row.payable)}</p>
      <p className="text-amber-700">Claimed: {fmtCur(row.claimed)}</p>
    </div>
  )
}

function Heatmap({ data, onCellClick }: { data: any; onCellClick?: (category: string, month: string) => void }) {
  const labels: string[] = data?.labels || []
  const rows: any[] = data?.rows || []
  const max = Number(data?.max || 0)

  const opacity = (value: number) => {
    if (!max || value <= 0) return 0.08
    return Math.max(0.14, Math.min(1, value / max))
  }

  if (!labels.length || !rows.length) {
    return <p className="py-8 text-center text-xs text-gray-400">No category mix available in this range</p>
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div className="grid" style={{ gridTemplateColumns: `180px repeat(${labels.length}, minmax(34px, 1fr))` }}>
          <div className="sticky left-0 bg-white px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Category</div>
          {labels.map(label => (
            <div key={label} className="px-1 py-1 text-center text-[10px] font-semibold text-gray-400">
              {label.slice(2)}
            </div>
          ))}
          {rows.map(row => (
            <>
              <div key={`${row.category}-label`} className="sticky left-0 bg-white px-2 py-1.5 text-xs font-semibold text-gray-700">
                <div className="truncate">{row.category}</div>
                <div className="text-[10px] font-medium text-gray-400">{fmtCur(row.total)}</div>
              </div>
              {row.values.map((value: number, index: number) => (
                <div
                  key={`${row.category}-${labels[index]}`}
                  title={`${row.category} · ${labels[index]}: ${fmtCur(value)}`}
                  onClick={onCellClick ? () => onCellClick(row.category, labels[index]) : undefined}
                  className={`m-1 h-7 rounded-md border border-slate-100 text-center text-[10px] font-bold text-slate-700 ${
                    onCellClick ? 'cursor-pointer transition hover:border-orange-300 hover:brightness-95' : ''
                  }`}
                  style={{ backgroundColor: `rgba(249, 115, 22, ${opacity(value)})` }}
                >
                  <span className="leading-7">{value ? shortCurrency(value) : ''}</span>
                </div>
              ))}
            </>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function TADAReportView() {
  const { label: travelLabel } = useModuleName('travel')
  const { success, error: showErr } = useToast()
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [showSave, setShowSave] = useState(false)
  const [showViews, setShowViews] = useState(false)
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const loadData = useCallback(async (applied: Record<string, string>, pg = 1) => {
    setLoading(true)
    try {
      const res = await reportsApi.tada({ ...toApiParams(applied), page: pg, per_page: 50 })
      setResult(res.data)
      setPage(pg)
    } catch {
      showErr('Failed to load TA / DA claims report')
    } finally {
      setLoading(false)
    }
  }, [showErr])

  const filterOptionsLoader = useCallback(async (): Promise<FilterOptionsMap> => {
    const r = await reportsApi.tadaFilterOptions()
    const d = r.data
    return {
      users: d.users || [],
      statuses: (d.statuses || []).map((s: string) => ({ id: s, name: s })),
      categories: (d.categories || []).map((s: string) => ({ id: s, name: s })),
      customers: d.customers || [],
    }
  }, [])

  const rf = useReportFilters(TADA_FILTER_CONFIG, filterOptionsLoader, loadData)

  useEffect(() => {
    reportsApi.savedViews('tada').then(r => setSavedViews(r.data)).catch(() => {})
    loadData(rf.applied)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doExport = async (fmt: 'csv' | 'excel') => {
    setExporting(true)
    try {
      const res = await reportsApi.tada({ ...toApiParams(rf.applied, { export: fmt }) } as any)
      const url = URL.createObjectURL(new Blob([res.data]))
      const a = document.createElement('a')
      a.href = url
      a.download = `tada_report.${fmt === 'excel' ? 'xlsx' : 'csv'}`
      a.click()
      URL.revokeObjectURL(url)
      success(`${fmt.toUpperCase()} downloaded`)
    } catch {
      showErr('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const saveView = async (name: string, is_shared: boolean) => {
    try {
      await reportsApi.createSavedView({ report_type: 'tada', name, filters: rf.applied as any, columns: [], is_shared })
      success('View saved')
      setShowSave(false)
      reportsApi.savedViews('tada').then(r => setSavedViews(r.data)).catch(() => {})
    } catch {
      showErr('Failed to save view')
    }
  }

  const deleteView = async (id: number) => {
    try {
      await reportsApi.deleteSavedView(id)
      reportsApi.savedViews('tada').then(r => setSavedViews(r.data)).catch(() => {})
    } catch {
      showErr('Delete failed')
    }
  }

  const setToolbar = useContext(ReportToolbarCtx)

  useEffect(() => {
    setToolbar(
      <>
        <button onClick={() => setShowSave(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 hover:bg-gray-50">
          <Save size={12} /> Save View
        </button>
        <button
          onClick={rf.run}
          disabled={loading}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 text-xs font-medium text-white shadow-sm hover:brightness-95 disabled:opacity-60"
        >
          <Play size={12} fill="currentColor" /> Run Report
        </button>
        <ReportActionsMenu title={`${travelLabel} TA/DA Report`} exportFilename="tada_report" columns={columns} data={data} />
      </>
    )
    return () => setToolbar(null)
  }, [setToolbar, loading, rf.run, savedViews.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const summary = result?.summary || {}
  const data = result?.data || []
  const pagination = result?.pagination || { total: 0, page: 1, per_page: 50, total_pages: 1 }
  const chartClaims = result?.chart_claim_timeline || []
  const chartStatuses = result?.chart_status_timeline || []
  const chartHeatmap = result?.chart_category_heatmap || null
  const chartScatter = result?.chart_settlement_scatter || []

  const columns: Column<Record<string, unknown>>[] = [
    { key: 'claim_number', header: 'Claim #', sortable: true, searchable: true, minWidth: '130px' },
    { key: 'employee', header: 'Employee', sortable: true, searchable: true, minWidth: '150px' },
    { key: 'claim_date', header: 'Claim Date', sortable: true, minWidth: '110px' },
    { key: 'purpose', header: 'Purpose', sortable: false, searchable: true, minWidth: '220px' },
    { key: 'categories', header: 'Categories', sortable: false, searchable: true, minWidth: '170px' },
    { key: 'total_amount', header: 'Claimed', sortable: true, align: 'right', minWidth: '120px', render: v => fmtCur(v) },
    { key: 'advance_taken', header: 'Advance', sortable: true, align: 'right', minWidth: '110px', render: v => fmtCur(v) },
    { key: 'net_payable', header: 'Payable', sortable: true, align: 'right', minWidth: '120px',
      render: v => <span className="font-semibold text-orange-700">{fmtCur(v)}</span> },
    { key: 'overall_status', header: 'Status', sortable: true, minWidth: '130px', render: v => <StatusBadge status={String(v || '')} /> },
    { key: 'payment_date', header: 'Paid Date', sortable: true, minWidth: '110px' },
    { key: 'mode_of_travel', header: 'Travel Mode', sortable: true, hidden: true },
    { key: 'department', header: 'Department', sortable: true, hidden: true },
    { key: 'travel_request_status', header: 'Travel Req', sortable: true, hidden: true },
    { key: 'payment_reference', header: 'Payment Ref', sortable: false, hidden: true },
    { key: 'created_at', header: 'Created', sortable: true, hidden: true },
  ]

  // Drilldown modal columns mirror the main table's columns (header -> label).
  const listCols: ColDef[] = columns
    .filter(c => !c.hidden)
    .map(c => ({
      key: c.key,
      label: c.header || c.label || c.key,
      render: c.render as ColDef['render'],
      align: c.align,
    }))

  const openList = (title: string, sub: string, list: any[]) => {
    setListDrill({ title, sub, rows: list, columns: listCols })
  }

  // Claims currently loaded on this page (result.data is server-paginated), grouped
  // by the same status buckets the backend uses to compute summary/chart totals.
  const paidRows = useMemo(
    () => data.filter((r: any) => r.overall_status === 'Paid'),
    [data],
  )

  const pendingRows = useMemo(
    () =>
      data.filter((r: any) =>
        ['Manager Approved', 'CEO Approved', 'Accounts Approved'].includes(r.overall_status),
      ),
    [data],
  )

  const rowsForMonth = (month: string) =>
    data.filter((r: any) => String(r.claim_date || '').startsWith(month))

  const rowsForCategory = (category: string, month: string) =>
    data.filter(
      (r: any) =>
        String(r.claim_date || '').startsWith(month) &&
        String(r.categories || '')
          .split(',')
          .map((s: string) => s.trim())
          .includes(category),
    )

  return (
    <div className="space-y-5">
      {showViews && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wide text-gray-700">Saved Views</h4>
            <button onClick={() => setShowViews(false)}><X size={14} className="text-gray-400" /></button>
          </div>
          {savedViews.length === 0 ? (
            <p className="py-4 text-center text-xs text-gray-400">No saved views yet</p>
          ) : (
            <div className="space-y-2">
              {savedViews.map(view => (
                <div key={view.id} className="group flex items-center gap-2 rounded-lg p-2 hover:bg-gray-50">
                  <button
                    onClick={() => {
                      Object.entries(view.filters).forEach(([k, v]) => rf.setFilter(k, v as string))
                      setShowViews(false)
                    }}
                    className="flex-1 text-left text-xs font-medium text-gray-700 hover:text-orange-600"
                  >
                    {view.name} {view.is_shared && <Share2 size={9} className="ml-1 inline text-gray-400" />}
                  </button>
                  <span className="text-[10px] text-gray-400">{view.created_by_name}</span>
                  {view.is_mine && (
                    <button onClick={() => deleteView(view.id)} className="text-red-400 opacity-0 hover:text-red-600 group-hover:opacity-100">
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ReportFilterBar config={TADA_FILTER_CONFIG} rf={rf} loading={loading} />

      {result && (
        <>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <KpiCard
              label="Total Claimed"
              value={fmtCur(summary.total_claimed)}
              icon={<Receipt size={16} className="text-orange-600" />}
              color="border-orange-100"
              onClick={() => openList('Total Claimed', 'Claims on this page contributing to total claimed amount', data)}
            />
            <KpiCard
              label="Net Payable"
              value={fmtCur(summary.total_payable)}
              icon={<Wallet size={16} className="text-blue-600" />}
              color="border-blue-100"
              onClick={() => openList('Net Payable', 'Claims on this page contributing to net payable amount', data)}
            />
            <KpiCard
              label="Paid Out"
              value={fmtCur(summary.paid_amount)}
              icon={<CheckCircle2 size={16} className="text-emerald-600" />}
              color="border-emerald-100"
              onClick={() => openList('Paid Out', 'Claims on this page marked as Paid', paidRows)}
            />
            <KpiCard
              label="Pending Settlement"
              value={fmtCur(summary.pending_settlement)}
              icon={<Clock size={16} className="text-amber-600" />}
              color="border-amber-100"
              onClick={() => openList('Pending Settlement', 'Claims on this page approved and awaiting payment', pendingRows)}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">Claimed vs Payable Trend</p>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart
                  data={chartClaims}
                  onClick={(state: any) => {
                    const month = state?.activeLabel
                    if (!month) return
                    openList(month, `Claims on this page from ${month}`, rowsForMonth(month))
                  }}
                  className="cursor-pointer"
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} tickFormatter={shortCurrency} />
                  <Tooltip content={<ChartTip />} />
                  <Area type="monotone" dataKey="claimed" stroke="#f97316" fill="#fdba74" fillOpacity={0.32} />
                  <Area type="monotone" dataKey="payable" stroke="#2563eb" fill="#93c5fd" fillOpacity={0.2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">Approval and Settlement Flow</p>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={chartStatuses}
                  onClick={(state: any) => {
                    const month = state?.activeLabel
                    if (!month) return
                    openList(month, `Claims on this page from ${month}`, rowsForMonth(month))
                  }}
                  className="cursor-pointer"
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTip />} />
                  <Line type="monotone" dataKey="submitted" stroke="#2563eb" strokeWidth={2.1} dot={false} />
                  <Line type="monotone" dataKey="approved" stroke="#0f766e" strokeWidth={2.1} dot={false} />
                  <Line type="monotone" dataKey="paid" stroke="#f97316" strokeWidth={2.1} dot={false} />
                  <Line type="monotone" dataKey="rejected" stroke="#dc2626" strokeWidth={2.1} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">Expense Category Heatmap</p>
              <Heatmap
                data={chartHeatmap}
                onCellClick={(category, month) =>
                  openList(
                    `${category} — ${month}`,
                    'Claims on this page in this category and month',
                    rowsForCategory(category, month),
                  )
                }
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <p className="text-xs font-semibold text-gray-700">
                {fmtNum(pagination.total)} claims{pagination.total_pages > 1 && ` · Page ${pagination.page} of ${pagination.total_pages}`}
              </p>
              {pagination.total_pages > 1 && (
                <div className="flex items-center gap-1">
                  <button disabled={page <= 1} onClick={() => loadData(rf.applied, page - 1)} className="h-7 w-7 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-30">‹</button>
                  {Array.from({ length: Math.min(5, pagination.total_pages) }, (_, index) => {
                    const p = Math.max(1, Math.min(pagination.total_pages - 4, page - 2)) + index
                    return (
                      <button key={p} onClick={() => loadData(rf.applied, p)} className={`h-7 w-7 rounded-lg text-xs font-medium ${p === page ? 'bg-orange-600 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                        {p}
                      </button>
                    )
                  })}
                  <button disabled={page >= pagination.total_pages} onClick={() => loadData(rf.applied, page + 1)} className="h-7 w-7 rounded-lg border border-gray-200 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-30">›</button>
                </div>
              )}
            </div>
            <DataTable columns={columns} data={data} loading={loading} emptyMessage="No claims match the current filters" />
          </div>
        </>
      )}

      {!result && loading && (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin text-orange-500" />
        </div>
      )}

      {showSave && <SaveModal onSave={saveView} onClose={() => setShowSave(false)} />}

      <ListDrilldownModal request={listDrill} onClose={() => setListDrill(null)} />
    </div>
  )
}
