/**
 * WorkordersReportView.tsx — Work Order Analytics report (Reports section).
 * Data source: GET /reports/workorders + /reports/workorders/filter-options (reports_router.py).
 * Enterprise analytics layout: SLA gauge + delay story, command metrics, monthly trend,
 * payment status by WO type, PM ranking, execution progress buckets, critical WO callouts,
 * and a full registry table. All KPIs/charts computed client-side from in-memory rows so
 * global search filters everything consistently.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AreaChart, Area, BarChart, Bar, CartesianGrid, Legend, XAxis, YAxis } from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, CHART, fmtN, fmtRsL, num, pct, ChartTip, Badge,
  Section, TabSkeleton, ColDef, AXIS_X, AXIS_Y, CGRID, Tooltip, ResponsiveContainer, exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import { AnalyticsFilterBar, AnalyticsFilterState, EMPTY_ANALYTICS_FILTERS } from './shared/AnalyticsFilterBar'
import { DrilldownRequest } from './shared/DrilldownDrawer'
import { RecordViewPanel } from '../report-engine/RecordViewPanel'
import { ListDrilldownModal, ListDrilldownRequest } from './shared/ListDrilldownModal'
import { DistributionSection } from './shared/DistributionCharts'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

// Server-side filters supported by GET /reports/workorders; search stays client-side.
function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()
  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.owner) p.set('project_manager_id', f.owner)
  if (f.status) p.set('status', f.status)
  if (f.customer_id) p.set('customer_id', f.customer_id)
  p.set('per_page', '1000')
  return p
}
const SERVER_KEYS: (keyof AnalyticsFilterState)[] = ['date_from', 'date_to', 'owner', 'status', 'customer_id']

const CLOSED_STATUSES = ['Completed', 'Closed', 'Cancelled']
const isOpen = (r: any) => !CLOSED_STATUSES.includes(r.status)

const PROGRESS_BUCKETS: Array<{ label: string; test: (p: number) => boolean }> = [
  { label: '0–25%',   test: p => p <= 25 },
  { label: '26–50%',  test: p => p > 25 && p <= 50 },
  { label: '51–75%',  test: p => p > 50 && p <= 75 },
  { label: '76–99%',  test: p => p > 75 && p < 100 },
  { label: '100%',    test: p => p >= 100 },
]


type MetricTone = 'blue' | 'red' | 'violet' | 'green'

const METRIC_TONES: Record<MetricTone, {
  border: string
  iconBg: string
  icon: string
  line: string
}> = {
  blue: {
    border: 'border-blue-200/80',
    iconBg: 'bg-blue-50 ring-blue-100',
    icon: 'text-blue-600',
    line: '#2563eb',
  },
  red: {
    border: 'border-rose-200/90',
    iconBg: 'bg-rose-50 ring-rose-100',
    icon: 'text-rose-500',
    line: '#f43f5e',
  },
  violet: {
    border: 'border-violet-200/80',
    iconBg: 'bg-violet-50 ring-violet-100',
    icon: 'text-violet-600',
    line: '#6d5dfc',
  },
  green: {
    border: 'border-emerald-200/90',
    iconBg: 'bg-emerald-50 ring-emerald-100',
    icon: 'text-emerald-600',
    line: '#10b981',
  },
}

function MetricGlyph({ kind }: { kind: 'folder' | 'clock' | 'target' | 'check' }) {
  if (kind === 'folder') {
    return (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h5.1l1.8 2.1h9.6v8.4a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V6.75Z" />
      </svg>
    )
  }
  if (kind === 'clock') {
    return (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8.25" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v5l3.25 2" />
      </svg>
    )
  }
  if (kind === 'target') {
    return (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="8.25" />
        <circle cx="12" cy="12" r="4.25" />
        <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="8.25" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.5 12 2.25 2.25L15.8 9.2" />
    </svg>
  )
}

function Sparkline({ color, points }: { color: string; points: number[] }) {
  const max = Math.max(...points, 1)
  const min = Math.min(...points)
  const range = Math.max(max - min, 1)
  const plot = points.map((value, index) => {
    const x = (index / Math.max(points.length - 1, 1)) * 72 + 4
    const y = 34 - ((value - min) / range) * 26
    return `${x},${y}`
  }).join(' ')

  return (
    <svg viewBox="0 0 80 40" className="h-11 w-20 overflow-visible" aria-hidden="true">
      <polyline points={plot} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {plot.split(' ').slice(-1).map((point) => {
        const [cx, cy] = point.split(',')
        return <circle key={point} cx={cx} cy={cy} r="2.25" fill={color} />
      })}
    </svg>
  )
}

function MetricCard({
  label,
  value,
  sub,
  tone,
  icon,
  points,
  onClick,
}: {
  label: string
  value: string
  sub: string
  tone: MetricTone
  icon: 'folder' | 'clock' | 'target' | 'check'
  points: number[]
  onClick: () => void
}) {
  const t = METRIC_TONES[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative min-h-[104px] overflow-hidden rounded-[18px] border bg-white px-4 py-3.5 text-left shadow-[0_7px_24px_rgba(15,23,42,0.055)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_30px_rgba(15,23,42,0.10)] ${t.border}`}
    >
      <div className="flex h-full items-center gap-3.5">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1 ${t.iconBg} ${t.icon}`}>
          <MetricGlyph kind={icon} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[9.5px] font-black uppercase tracking-[0.15em] text-slate-500">{label}</div>
          <div className="mt-1 text-[25px] font-black leading-none tracking-[-0.04em] text-slate-950">{value}</div>
          <div className="mt-1.5 truncate text-[10.5px] text-slate-500">{sub}</div>
        </div>
        <Sparkline color={t.line} points={points} />
      </div>
    </button>
  )
}

function DashboardPanel({
  title,
  sub,
  action,
  children,
  className = '',
}: {
  title: string
  sub: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`overflow-hidden rounded-[20px] border border-slate-200/80 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.055)] ${className}`}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4.5">
        <div>
          <h3 className="text-[13px] font-bold tracking-[-0.01em] text-slate-950">{title}</h3>
          <p className="mt-0.5 text-[10.5px] text-slate-500">{sub}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function formatMonthLabel(value: string) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return value
  const [year, month] = value.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

export default function WorkordersReportView() {
  const {
    label: woLabel,
    singular: woSingular,
    labelLower: woLabelLower,
    singularLower: woSingularLower,
  } = useModuleName('workorders')
  const { singular: customerSingular, singularLower: customerSingularLower } = useModuleName('customers')
  const [rows, setRows] = useState<any[]>([])
  const [options, setOptions] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const initialGlobalRange = useInitialGlobalDateRange()
  const [filters, setFilters] = useState<AnalyticsFilterState>(() => ({ ...EMPTY_ANALYTICS_FILTERS, ...initialGlobalRange }))
  const [drilldown, setDrilldown] = useState<DrilldownRequest | null>(null)
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const loadData = useCallback(async (f: AnalyticsFilterState) => {
    setLoading(true)
    try {
      const res = await api.get(`/reports/workorders?${toBackendParams(f)}`)
      setRows(res.data?.data || [])
    } catch { setRows([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    loadData(filters)
    api.get('/reports/workorders/filter-options')
      .then(r => setOptions(r.data))
      .catch(() => setOptions(null))
  }, [loadData]) // eslint-disable-line react-hooks/exhaustive-deps -- runs once on mount with the (possibly toolbar-seeded) initial filters

  const handleChange = (k: keyof AnalyticsFilterState, v: string) => {
    const next = { ...filters, [k]: v }
    setFilters(next)
    if (SERVER_KEYS.includes(k)) loadData(next)
  }

  useGlobalDateRangeSync((date_from, date_to) => {
    const next = { ...filters, date_from, date_to }
    setFilters(next)
    loadData(next)
  })

  const handleReset = () => {
    setFilters(EMPTY_ANALYTICS_FILTERS)
    loadData(EMPTY_ANALYTICS_FILTERS)
  }

  const tableRows = useMemo(() => {
    if (!filters.search) return rows
    const q = filters.search.toLowerCase()
    return rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)))
  }, [rows, filters.search])

  // ─── Derived metrics ─────────────────────────────────────────────────────────
  const openRows = useMemo(() => tableRows.filter(isOpen), [tableRows])
  const pendingValue = useMemo(() => openRows.reduce((s, r) => s + num(r.wo_value), 0), [openRows])

  const delayedRows = useMemo(() => tableRows.filter(r =>
    r.status === 'Delayed' || (r.days_to_due != null && num(r.days_to_due) < 0 && isOpen(r))), [tableRows])
  const delayedNums = useMemo(() => new Set(delayedRows.map(r => r.wo_number)), [delayedRows])
  const delayedOpen = useMemo(() => delayedRows.filter(isOpen), [delayedRows])
  const slaOnTrack = Math.max(0, openRows.length - delayedOpen.length)
  const onTrackRows = useMemo(() => openRows.filter(r => !delayedNums.has(r.wo_number)), [openRows, delayedNums])
  const delayedValue = useMemo(() => delayedRows.reduce((s, r) => s + num(r.wo_value), 0), [delayedRows])

  const avgProgress = useMemo(() => {
    if (!openRows.length) return 0
    return Math.round(openRows.reduce((s, r) => s + num(r.progress_percent), 0) / openRows.length)
  }, [openRows])
  const onTimeRate = pct(slaOnTrack, openRows.length)

  const monthlyTrend = useMemo(() => {
    const m: Record<string, { count: number; completed: number }> = {}
    tableRows.forEach(r => {
      const key = (r.created_at || '').slice(0, 7)
      if (!key) return
      if (!m[key]) m[key] = { count: 0, completed: 0 }
      m[key].count++
      if (r.status === 'Completed' || r.status === 'Closed') m[key].completed++
    })
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, v]) => ({ month, ...v }))
  }, [tableRows])

  const statusByType = useMemo(() => {
    const m: Record<string, { Completed: number; Delayed: number; 'In Progress': number }> = {}
    tableRows.forEach(r => {
      const t = r.wo_type || 'Other'
      if (!m[t]) m[t] = { Completed: 0, Delayed: 0, 'In Progress': 0 }
      if (CLOSED_STATUSES.includes(r.status)) m[t].Completed++
      else if (delayedNums.has(r.wo_number)) m[t].Delayed++
      else m[t]['In Progress']++
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => (b.Completed + b.Delayed + b['In Progress']) - (a.Completed + a.Delayed + a['In Progress']))
  }, [tableRows, delayedNums])

  const pmRanking = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const p = r.project_manager || 'Unassigned'
      m[p] = (m[p] || 0) + 1
    })
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }, [tableRows])

  const progressBucketRows = useMemo(() =>
    PROGRESS_BUCKETS.map(b => ({
      label: b.label,
      rows: tableRows.filter(r => b.test(num(r.progress_percent))),
    })), [tableRows])

  const criticalWO = useMemo(() =>
    [...delayedRows].sort((a, b) => num(b.wo_value) - num(a.wo_value)).slice(0, 4), [delayedRows])

  // ── New: financial comparison cards (WO Value vs Received, Outstanding by Customer) ──
  const woValueTotal = useMemo(() => tableRows.reduce((s, r) => s + num(r.wo_value), 0), [tableRows])
  const receivedTotal = useMemo(() => tableRows.reduce((s, r) => s + num(r.total_paid), 0), [tableRows])
  const outstandingByCustomer = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const due = num(r.due_invoice_amount)
      if (due <= 0) return
      const name = r.customer_name || 'Unknown'
      m[name] = (m[name] || 0) + due
    })
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8)
  }, [tableRows])
  const maxOutstandingCustomer = Math.max(...outstandingByCustomer.map(c => c.value), 1)

  const cols: ColDef[] = [
    { key: 'wo_number', label: `${woSingular} No`, render: v => <span className="font-mono text-[10px] text-slate-500">{v || '—'}</span> },
    { key: 'project_title', label: 'Project', render: v => <span className="font-semibold text-slate-900 truncate max-w-[220px] block">{v || '—'}</span> },
    { key: 'customer_name', label: customerSingular },
    { key: 'status', label: 'Status', render: v => v ? <Badge text={v} /> : null },
    { key: 'wo_value', label: `${woSingular} Value ₹`, money: true, align: 'right' },
    { key: 'delivery_date', label: 'Delivery', render: v => <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span> },
    { key: 'project_manager', label: 'Project Manager' },
  ]

  const openRow = (row: any) => setDrilldown({ entity: 'workorder', id: row.id, label: row.project_title || row.wo_number, seedRow: row })

  const openList = (title: string, sub: string, list: any[]) =>
    setListDrill({ title, sub, rows: list, columns: cols })

  const openStatusSlice = (raw: any, dataKey: 'Completed' | 'In Progress' | 'Delayed') => {
    const row = raw?.payload || raw
    if (!row?.name) return
    const typeRows = tableRows.filter(r => (r.wo_type || 'Other') === row.name)
    const filtered = dataKey === 'Completed'
      ? typeRows.filter(r => CLOSED_STATUSES.includes(r.status))
      : dataKey === 'Delayed'
        ? typeRows.filter(r => delayedNums.has(r.wo_number))
        : typeRows.filter(r => !CLOSED_STATUSES.includes(r.status) && !delayedNums.has(r.wo_number))
    openList(`${row.name} — ${dataKey}`, `${woLabel} in this status / type combination`, filtered)
  }

  const maxPmCount = Math.max(...pmRanking.map(item => item.count), 1)
  const overdueRate = openRows.length ? Math.max(0, 100 - onTimeRate) : 0

  if (loading && !rows.length) return <TabSkeleton />

  return (
    <div className="space-y-5 pb-6">
      {/* Premium page heading — data logic and surrounding application shell remain unchanged */}
      <div className="flex flex-col gap-3 px-0.5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[24px] font-black tracking-[-0.035em] text-slate-950">{woLabel}</h1>
          <p className="mt-0.5 text-[11.5px] text-slate-500">Real-time overview of {woSingularLower} execution and productivity</p>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] font-semibold text-slate-500 shadow-sm lg:flex">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          Live analytics from backend data
        </div>
      </div>

      <AnalyticsFilterBar
        filters={filters}
        onChange={handleChange}
        onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() => exportRows(tableRows, cols, 'workorders')}
        filterOptions={{
          owners: options?.users,
          statuses: options?.statuses,
          customers: options?.customers,
        }}
        loading={loading}
      />

      {/* KPI command strip */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={`Pending ${woSingular} Value`}
          value={fmtRsL(pendingValue)}
          sub="yet to complete"
          tone="blue"
          icon="folder"
          points={[3, 5, 4, 8, 6, 10, 9, 14]}
          onClick={() => openList(`Pending ${woSingular} Value`, `Open ${woLabelLower} yet to complete`, openRows)}
        />
        <MetricCard
          label={`Delayed ${woLabel}`}
          value={fmtN(delayedRows.length)}
          sub="beyond committed date"
          tone="red"
          icon="clock"
          points={[2, 7, 4, 8, 6, 11, 7, 13]}
          onClick={() => openList(`Delayed ${woLabel}`, `${woLabel} beyond committed date`, delayedRows)}
        />
        <MetricCard
          label="Avg Progress"
          value={`${avgProgress}%`}
          sub={`across open ${woLabelLower}`}
          tone="violet"
          icon="target"
          points={[2, 4, 3, 6, 7, 6, 9, 8]}
          onClick={() => openList('Avg Progress', `Open ${woLabelLower} included in the average`, openRows)}
        />
        <MetricCard
          label="On-Time Rate"
          value={`${onTimeRate}%`}
          sub={`open ${woLabelLower} on schedule`}
          tone="green"
          icon="check"
          points={[2, 5, 3, 8, 5, 9, 7, 11]}
          onClick={() => openList('On-Time Rate', `Open ${woLabelLower} currently on schedule`, onTrackRows)}
        />
      </div>

      {/* Main analytics composition matching the approved visual */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <DashboardPanel
          title="Monthly WO Trend"
          sub="Work orders created vs completed by month"
          className="xl:col-span-5"
          action={
            <span className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-700 shadow-sm">
              Monthly
            </span>
          }
        >
          <div className="h-[255px] px-2 pb-3 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthlyTrend} margin={{ top: 12, right: 12, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="woPremiumCreated" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.24} />
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity={0.015} />
                  </linearGradient>
                  <linearGradient id="woPremiumDone" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#16a36a" stopOpacity={0.16} />
                    <stop offset="100%" stopColor="#16a36a" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...CGRID} vertical={false} stroke="#e8edf5" />
                <XAxis
                  dataKey="month"
                  tick={{ ...AXIS_X, fontSize: 9 }}
                  tickFormatter={formatMonthLabel}
                  axisLine={{ stroke: '#dce3ed' }}
                  tickLine={false}
                  minTickGap={18}
                />
                <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={30} />
                <Tooltip content={<ChartTip />} />
                <Legend
                  verticalAlign="top"
                  align="right"
                  iconType="circle"
                  iconSize={7}
                  wrapperStyle={{ fontSize: 10, color: '#64748b', top: -2 }}
                />
                <Area
                  dataKey="count"
                  name="Created"
                  type="monotone"
                  stroke="#4f46e5"
                  strokeWidth={2.2}
                  fill="url(#woPremiumCreated)"
                  dot={{ r: 2.7, fill: '#4f46e5', strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                />
                <Area
                  dataKey="completed"
                  name="Completed"
                  type="monotone"
                  stroke="#16a36a"
                  strokeWidth={2}
                  fill="url(#woPremiumDone)"
                  dot={{ r: 2.5, fill: '#16a36a', strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="Execution Status by WO Type"
          sub="Completed vs in-progress vs delayed counts"
          className="xl:col-span-4"
        >
          <div className="h-[255px] px-2 pb-3 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusByType} margin={{ top: 12, right: 12, bottom: 4, left: -6 }} barCategoryGap="28%">
                <CartesianGrid {...CGRID} vertical={false} stroke="#e8edf5" />
                <XAxis
                  dataKey="name"
                  tick={{ ...AXIS_X, fontSize: 9 }}
                  axisLine={{ stroke: '#dce3ed' }}
                  tickLine={false}
                  interval={0}
                />
                <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
                <Tooltip content={<ChartTip />} />
                <Legend
                  verticalAlign="top"
                  align="center"
                  iconType="circle"
                  iconSize={7}
                  wrapperStyle={{ fontSize: 9.5, color: '#64748b', top: -2 }}
                />
                <Bar
                  dataKey="Completed"
                  name="Completed"
                  stackId="execution"
                  fill="#16a36a"
                  radius={[0, 0, 4, 4]}
                  cursor="pointer"
                  onClick={(data) => openStatusSlice(data, 'Completed')}
                />
                <Bar
                  dataKey="In Progress"
                  name="In Progress"
                  stackId="execution"
                  fill="#4f46e5"
                  cursor="pointer"
                  onClick={(data) => openStatusSlice(data, 'In Progress')}
                />
                <Bar
                  dataKey="Delayed"
                  name="Delayed"
                  stackId="execution"
                  fill="#ef233c"
                  radius={[4, 4, 0, 0]}
                  cursor="pointer"
                  onClick={(data) => openStatusSlice(data, 'Delayed')}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="SLA Compliance"
          sub="Open work orders on schedule"
          className="xl:col-span-3"
        >
          <div className="px-4 pb-4 pt-3">
            <div className="grid grid-cols-[1.05fr_.95fr] items-center gap-3">
              <button
                type="button"
                onClick={() => openList('SLA Compliance — On Track', 'Open work orders currently on schedule', onTrackRows)}
                className="group relative h-[135px] rounded-2xl transition hover:bg-slate-50"
              >
                <svg viewBox="0 0 140 92" className="absolute inset-x-0 top-0 mx-auto h-[100px] w-[150px]">
                  <path
                    d="M20 76 A50 50 0 0 1 120 76"
                    fill="none"
                    stroke="#e8edf4"
                    strokeWidth="15"
                    strokeLinecap="round"
                    pathLength="100"
                  />
                  <path
                    d="M20 76 A50 50 0 0 1 120 76"
                    fill="none"
                    stroke="#19a66f"
                    strokeWidth="15"
                    strokeLinecap="round"
                    pathLength="100"
                    strokeDasharray={`${Math.min(onTimeRate, 100)} 100`}
                  />
                </svg>
                <div className="absolute inset-x-0 top-[52px] text-center">
                  <div className="text-[23px] font-black tracking-[-0.04em] text-slate-950">{onTimeRate}%</div>
                  <div className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">On Track</div>
                </div>
              </button>

              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/70">
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-[10px]">
                  <span className="flex items-center gap-1.5 text-slate-600"><i className="h-2 w-2 rounded-full bg-emerald-500" />On Track</span>
                  <b className="text-slate-950">{onTimeRate}%</b>
                </div>
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-[10px]">
                  <span className="flex items-center gap-1.5 text-slate-600"><i className="h-2 w-2 rounded-full bg-amber-400" />At Risk</span>
                  <b className="text-slate-950">0%</b>
                </div>
                <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 text-[10px]">
                  <span className="flex items-center gap-1.5 text-slate-600"><i className="h-2 w-2 rounded-full bg-rose-500" />Overdue</span>
                  <b className="text-slate-950">{overdueRate}%</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 text-[10px]">
                  <span className="text-slate-600">Total WO</span>
                  <b className="text-slate-950">{fmtN(openRows.length)}</b>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => openList('Delayed Work Orders', 'Work orders running behind schedule', delayedRows)}
              className="mt-2.5 flex w-full items-center gap-3 rounded-2xl border border-blue-200/80 bg-gradient-to-r from-blue-50 to-indigo-50/70 p-3 text-left transition hover:border-blue-300 hover:shadow-sm"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-blue-500 text-white shadow-[0_7px_16px_rgba(79,70,229,0.28)]">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 18h6M10 21h4M8.2 14.5A6 6 0 1 1 15.8 14.5c-.9.75-1.3 1.3-1.45 2H9.65c-.15-.7-.55-1.25-1.45-2Z" />
                </svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-black text-slate-950">
                  {delayedRows.length > 0 ? `${fmtN(delayedRows.length)} work orders are delayed` : 'All work orders on schedule'}
                </span>
                <span className="mt-0.5 block text-[9.5px] leading-4 text-slate-600">
                  {delayedRows.length > 0
                    ? `${fmtRsL(delayedValue)} of committed value is running behind schedule and needs execution attention.`
                    : 'No open work orders are past their committed date.'}
                </span>
              </span>
              <span className="text-lg text-indigo-600">›</span>
            </button>
          </div>
        </DashboardPanel>
      </div>

      {/* Ranking, progress and critical work orders */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <DashboardPanel title="Project Manager Ranking" sub="Work orders managed">
          <div className="space-y-3 px-5 pb-5 pt-4">
            {pmRanking.slice(0, 5).map((item, index) => (
              <button
                type="button"
                key={item.name}
                onClick={() => openList(item.name, 'Work orders managed by this project manager',
                  tableRows.filter(r => (r.project_manager || 'Unassigned') === item.name))}
                className="grid w-full grid-cols-[24px_1fr_26px] items-center gap-2 rounded-xl p-1 text-left transition hover:bg-slate-50"
              >
                <span className="text-[10px] font-bold text-slate-400">{String(index + 1).padStart(2, '0')}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[11.5px] font-bold text-slate-900">{item.name}</span>
                  <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <span
                      className="block h-full rounded-full bg-gradient-to-r from-indigo-600 to-blue-400"
                      style={{ width: `${Math.max(4, (item.count / maxPmCount) * 100)}%` }}
                    />
                  </span>
                </span>
                <span className="text-right text-[11px] font-black text-slate-950">{fmtN(item.count)}</span>
              </button>
            ))}
            {pmRanking.length === 0 && <p className="py-8 text-center text-[11px] text-slate-400">No project manager data</p>}
          </div>
        </DashboardPanel>

        <DashboardPanel title="Execution Progress" sub="Distribution by completion band">
          <div className="space-y-3 px-5 pb-5 pt-4">
            {progressBucketRows.map((bucket, index) => {
              const share = pct(bucket.rows.length, tableRows.length)
              return (
                <button
                  type="button"
                  key={bucket.label}
                  onClick={() => openList(bucket.label, 'Work orders in this completion band', bucket.rows)}
                  className="grid w-full grid-cols-[50px_1fr_28px_34px] items-center gap-2 rounded-xl p-1 text-left transition hover:bg-slate-50"
                >
                  <span className="text-[11px] font-medium text-slate-700">{bucket.label}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${share}%`,
                        background: index === 0
                          ? 'linear-gradient(90deg,#4f46e5,#2563eb)'
                          : CHART[index % CHART.length],
                      }}
                    />
                  </span>
                  <span className="text-right text-[11px] font-black text-slate-950">{fmtN(bucket.rows.length)}</span>
                  <span className="text-right text-[10px] text-slate-400">{share}%</span>
                </button>
              )
            })}
          </div>
        </DashboardPanel>

        <DashboardPanel
          title="Critical WO"
          sub="Highest-value delayed work orders"
          action={
            <button
              type="button"
              onClick={() => openList('Critical Work Orders', 'Highest-value delayed work orders', delayedRows)}
              className="text-[10px] font-bold text-indigo-600 hover:text-indigo-800"
            >
              View all
            </button>
          }
        >
          <div className="divide-y divide-slate-100 px-5 pb-3 pt-2">
            {criticalWO.length === 0 ? (
              <p className="py-10 text-center text-[11px] text-slate-400">No delayed work orders — execution on track</p>
            ) : criticalWO.slice(0, 4).map((row, index) => (
              <button
                type="button"
                key={row.wo_number || index}
                onClick={() => openRow(row)}
                className="grid w-full grid-cols-[18px_1fr_auto] items-center gap-2.5 py-3 text-left transition hover:bg-slate-50"
              >
                <span className="text-[10px] font-bold text-slate-400">{index + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[11.5px] font-bold text-slate-950">{row.project_title || row.wo_number || '—'}</span>
                  <span className="mt-0.5 block truncate text-[9.5px] text-slate-500">{fmtRsL(num(row.wo_value))} · {row.customer_name || '—'}</span>
                </span>
                <span className="rounded-md bg-rose-50 px-2 py-1 text-[8.5px] font-black uppercase tracking-wide text-rose-500">Overdue</span>
              </button>
            ))}
          </div>
        </DashboardPanel>
      </div>

      {/* Existing financial analytics retained, restyled only */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <DashboardPanel title="Work Order Value vs Received Amount" sub="Booked order value vs amount actually collected">
          <div className="space-y-4 px-5 pb-5 pt-4">
            <div>
              <div className="flex items-center justify-between text-[10.5px] font-semibold text-slate-600">
                <span>WO Value</span>
                <span className="font-black text-slate-950">{fmtRsL(woValueTotal)}</span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-full rounded-full bg-gradient-to-r from-indigo-700 to-indigo-500" />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-[10.5px] font-semibold text-slate-600">
                <span>Received</span>
                <span className="font-black text-slate-950">{fmtRsL(receivedTotal)}</span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-600 to-emerald-400"
                  style={{ width: `${woValueTotal ? Math.min(100, (receivedTotal / woValueTotal) * 100) : 0}%` }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-[10px] text-slate-500">
              <span>Collection efficiency</span>
              <b className="text-slate-900">{pct(receivedTotal, woValueTotal || 1)}%</b>
            </div>
          </div>
        </DashboardPanel>

        <DashboardPanel title="Outstanding by Customer" sub="Unpaid invoice amount by customer">
          <div className="space-y-3 px-5 pb-5 pt-4">
            {outstandingByCustomer.length === 0 && (
              <p className="py-7 text-center text-[11px] text-slate-400">No outstanding amounts</p>
            )}
            {outstandingByCustomer.map(customer => (
              <button
                type="button"
                key={customer.name}
                onClick={() => openList(
                  customer.name,
                  'Work orders with outstanding amount for this customer',
                  tableRows.filter(r => (r.customer_name || 'Unknown') === customer.name && num(r.due_invoice_amount) > 0),
                )}
                className="block w-full rounded-xl p-1 text-left transition hover:bg-slate-50"
              >
                <span className="flex items-center justify-between gap-3 text-[10.5px]">
                  <span className="truncate font-semibold text-slate-800">{customer.name}</span>
                  <span className="shrink-0 font-black text-slate-950">{fmtRsL(customer.value)}</span>
                </span>
                <span className="mt-1.5 block h-2 overflow-hidden rounded-full bg-slate-100">
                  <span
                    className="block h-full rounded-full bg-gradient-to-r from-rose-500 to-orange-400"
                    style={{ width: `${(customer.value / maxOutstandingCustomer) * 100}%` }}
                  />
                </span>
              </button>
            ))}
          </div>
        </DashboardPanel>
      </div>

      {/* Existing distribution intelligence and registry are unchanged */}
      <DistributionSection
        rows={rows}
        config={{ bu: 'bubble', bv: 'lollipop', src: 'donut', seg: 'trend' }}
        module="Work Orders"
        getBU={r => r.business_vertical || 'Unclassified'}
        getBV={r => r.business_vertical_group || r.business_vertical || 'Unclassified'}
        getSrc={r => r.source_portal || 'Other'}
        getSeg={r => r.customer_segment || 'Unclassified'}
        getResult={r => ['Completed', 'Closed'].includes(r.status) ? 'Won' : r.status === 'Cancelled' ? 'Cancelled' : r.status || ''}
        getValue={r => Number(r.wo_value || r.po_value || 0)}
        onOpenRows={openList}
      />

      <Section idx="02" title="Work Order Registry" desc="Complete work order list" />
      <DataTable
        data={tableRows}
        columns={cols as any}
        title="workorders"
        onRowClick={openRow}
        showExport
        showColumnToggle
      />

      <RecordViewPanel request={drilldown} onClose={() => setDrilldown(null)} />

      <ListDrilldownModal
        request={listDrill}
        onClose={() => setListDrill(null)}
        onRowClick={row => {
          setListDrill(null)
          openRow(row)
        }}
      />
    </div>
  )
}