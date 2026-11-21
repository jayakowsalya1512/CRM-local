/**
 * CustomerAnalyticsView.tsx — Customer Analytics report (Reports section).
 *
 * UI fully redesigned to match the new Analytical Reports dashboard style.
 * Existing API calls, filters, client-side calculations, drilldown behavior,
 * export behavior, and DataTable integration remain unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CalendarDays,
  CircleDollarSign,
  Filter,
  RefreshCw,
  TrendingUp,
  UserPlus,
  Users,
  WalletCards,
} from 'lucide-react'

import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  CHART,
  fmtN,
  fmtRsL,
  num,
  pct,
  TabSkeleton,
  ColDef,
  exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import { PipelineConversionCard } from '../dashboard/tabs/_analyticsCharts'
import {
  AnalyticsFilterBar,
  AnalyticsFilterState,
  EMPTY_ANALYTICS_FILTERS,
} from './shared/AnalyticsFilterBar'
import { DrilldownRequest } from './shared/DrilldownDrawer'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'
import { RecordViewPanel } from '../report-engine/RecordViewPanel'
import {
  ListDrilldownModal,
  ListDrilldownRequest,
} from './shared/ListDrilldownModal'

function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()

  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.owner) p.set('assigned_to', f.owner)
  if (f.region) p.set('billing_city', f.region)
  if (f.state) p.set('billing_state', f.state)

  p.set('per_page', '1000')
  return p
}

const SERVER_KEYS: (keyof AnalyticsFilterState)[] = [
  'date_from',
  'date_to',
  'owner',
  'region',
  'state',
]

type Health = 'Healthy' | 'Watchlist' | 'At Risk'

function healthOf(r: any): Health {
  const st = String(r.account_status || '').toLowerCase()

  if (st === 'inactive' || st === 'churned') return 'At Risk'
  if (num(r.open_pipeline_value) > 0) return 'Healthy'

  return 'Watchlist'
}

type Tone = 'primary' | 'info' | 'success' | 'warning' | 'danger' | 'purple'

const toneMap: Record<
  Tone,
  {
    iconBg: string
    iconText: string
    trendText: string
    trendBg: string
    border: string
  }
> = {
  primary: {
    iconBg: 'bg-indigo-50',
    iconText: 'text-indigo-600',
    trendText: 'text-emerald-700',
    trendBg: 'bg-emerald-50',
    border: 'border-indigo-100',
  },
  info: {
    iconBg: 'bg-sky-50',
    iconText: 'text-sky-600',
    trendText: 'text-emerald-700',
    trendBg: 'bg-emerald-50',
    border: 'border-sky-100',
  },
  success: {
    iconBg: 'bg-emerald-50',
    iconText: 'text-emerald-600',
    trendText: 'text-emerald-700',
    trendBg: 'bg-emerald-50',
    border: 'border-emerald-100',
  },
  warning: {
    iconBg: 'bg-amber-50',
    iconText: 'text-amber-600',
    trendText: 'text-amber-700',
    trendBg: 'bg-amber-50',
    border: 'border-amber-100',
  },
  danger: {
    iconBg: 'bg-rose-50',
    iconText: 'text-rose-600',
    trendText: 'text-rose-700',
    trendBg: 'bg-rose-50',
    border: 'border-rose-100',
  },
  purple: {
    iconBg: 'bg-violet-50',
    iconText: 'text-violet-600',
    trendText: 'text-emerald-700',
    trendBg: 'bg-emerald-50',
    border: 'border-violet-100',
  },
}

function DashboardPanel({
  title,
  sub,
  children,
  className = '',
}: {
  title: string
  sub?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={`rounded-[18px] border border-slate-200/80 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.045)] ${className}`}
    >
      <div className="border-b border-slate-100 px-4 py-3.5">
        <div className="text-[13px] font-bold uppercase tracking-[0.02em] text-slate-900">
          {title}
        </div>
        {sub ? (
          <div className="mt-1 text-[11px] leading-4 text-slate-500">{sub}</div>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  )
}

function DashboardKpiCard({
  label,
  value,
  sub,
  tone,
  icon,
  onClick,
}: {
  label: string
  value: string
  sub?: string
  tone: Tone
  icon: React.ReactNode
  onClick?: () => void
}) {
  const t = toneMap[tone]

  return (
    <div
      onClick={onClick}
      className={`min-w-0 rounded-[16px] border bg-white p-4 py-3.5 shadow-[0_5px_20px_rgba(15,23,42,0.045)] ${t.border} ${
        onClick ? 'cursor-pointer transition hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgba(15,23,42,0.09)]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
    className="
        text-[11px]
        font-bold
        uppercase
        tracking-[0.04em]
        text-slate-500
        leading-4
        min-h-[32px]
        whitespace-normal
        break-words
    "
>
    {label}
</div>
<div className="mt-1 text-[22px] font-extrabold tracking-tight text-slate-950">            {value}
          </div>
        </div>

        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] ${t.iconBg} ${t.iconText}`}
        >
          {icon}
        </div>
      </div>

      {sub ? (
        <div className="mt-3">
          <span
            className={`inline-flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold ${t.trendBg} ${t.trendText}`}
          >
            <TrendingUp size={11} strokeWidth={2.3} />
            <span className="truncate">{sub}</span>
          </span>
        </div>
      ) : (
        <div className="mt-3 h-6" />
      )}
    </div>
  )
}

function Sparkline({
  tone,
}: {
  tone: 'red' | 'orange' | 'green'
}) {
  const stroke =
    tone === 'red'
      ? '#ef4444'
      : tone === 'orange'
        ? '#f59e0b'
        : '#10b981'

  return (
    <svg
      viewBox="0 0 130 34"
      className="h-9 w-[130px]"
      aria-hidden="true"
    >
      <path
        d="M2 24 L16 21 L29 24 L42 14 L56 18 L70 8 L83 12 L96 24 L110 27 L128 22"
        fill="none"
        stroke={stroke}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 31 L2 24 L16 21 L29 24 L42 14 L56 18 L70 8 L83 12 L96 24 L110 27 L128 22 L128 31 Z"
        fill={stroke}
        opacity="0.07"
      />
    </svg>
  )
}

function RiskSignalCard({
  title,
  description,
  value,
  tone,
  onClick,
}: {
  title: string
  description: string
  value: string
  tone: 'red' | 'orange' | 'green'
  onClick?: () => void
}) {
  const styles = {
    red: {
      border: 'border-l-rose-500',
      bg: 'bg-rose-50/30',
      title: 'text-rose-600',
      value: 'text-rose-600',
    },
    orange: {
      border: 'border-l-amber-500',
      bg: 'bg-amber-50/30',
      title: 'text-amber-600',
      value: 'text-amber-600',
    },
    green: {
      border: 'border-l-emerald-500',
      bg: 'bg-emerald-50/30',
      title: 'text-emerald-600',
      value: 'text-emerald-600',
    },
  }[tone]

  return (
    <div
      onClick={onClick}
      className={`rounded-[15px] border border-slate-200 border-l-[3px] p-4 ${styles.border} ${styles.bg} ${
        onClick ? 'cursor-pointer transition hover:brightness-[0.98]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={`text-[11px] font-extrabold uppercase tracking-[0.035em] ${styles.title}`}
          >
            {title}
          </div>
          <div className="mt-1.5 text-[11px] leading-4 text-slate-500">
            {description}
          </div>
          <div className={`mt-2 text-[20px] font-extrabold ${styles.value}`}>
            {value}
          </div>
        </div>

        <div className="shrink-0 pt-3">
          <Sparkline tone={tone} />
        </div>
      </div>
    </div>
  )
}

function HealthDonut({
  healthy,
  watchlist,
  atRisk,
  total,
  onSegmentClick,
}: {
  healthy: number
  watchlist: number
  atRisk: number
  total: number
  onSegmentClick?: (label: 'Healthy' | 'Watchlist' | 'At Risk' | 'Inactive') => void
}) {
  const { label: customerLabel } = useModuleName('customers')
  const safeTotal = total || 1

  const healthyPct = (healthy / safeTotal) * 100
  const watchPct = (watchlist / safeTotal) * 100
  const riskPct = (atRisk / safeTotal) * 100

  const c1 = healthyPct
  const c2 = healthyPct + watchPct
  const c3 = healthyPct + watchPct + riskPct

  const background = `conic-gradient(
    #10b981 0% ${c1}%,
    #f59e0b ${c1}% ${c2}%,
    #ef4444 ${c2}% ${c3}%,
    #e2e8f0 ${c3}% 100%
  )`

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
      <div className="relative mx-auto h-[152px] w-[152px] shrink-0 lg:mx-0">
        <div
          className="absolute inset-0 rounded-full"
          style={{ background }}
        />
        <div className="absolute inset-[26px] flex flex-col items-center justify-center rounded-full bg-white shadow-inner">
          <div className="text-[24px] font-extrabold text-slate-900">
            {pct(healthy, safeTotal)}%
          </div>
          <div className="text-[11px] font-semibold text-slate-500">Healthy</div>
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-3">
        {[
          {
            label: 'Healthy',
            count: healthy,
            color: 'bg-emerald-500',
            percent: pct(healthy, safeTotal),
          },
          {
            label: 'Watchlist',
            count: watchlist,
            color: 'bg-amber-500',
            percent: pct(watchlist, safeTotal),
          },
          {
            label: 'At Risk',
            count: atRisk,
            color: 'bg-rose-500',
            percent: pct(atRisk, safeTotal),
          },
          {
            label: 'Inactive',
            count: Math.max(total - healthy - watchlist - atRisk, 0),
            color: 'bg-slate-300',
            percent: pct(
              Math.max(total - healthy - watchlist - atRisk, 0),
              safeTotal,
            ),
          },
        ].map(item => (
          <div
            key={item.label}
            onClick={
              onSegmentClick
                ? () =>
                    onSegmentClick(
                      item.label as 'Healthy' | 'Watchlist' | 'At Risk' | 'Inactive',
                    )
                : undefined
            }
            className={`flex items-center gap-3 rounded-lg ${
              onSegmentClick ? 'cursor-pointer hover:bg-slate-50' : ''
            }`}
          >
            <span className={`h-2.5 w-2.5 rounded-full ${item.color}`} />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-600">
              {item.label}
            </span>
            <span className="text-[11px] font-bold text-slate-900">
              {fmtN(item.count)} ({item.percent}%)
            </span>
          </div>
        ))}

        <div className="pt-1 text-[11px] font-bold text-slate-700">
          Total {customerLabel}: {fmtN(total)}
        </div>
      </div>
    </div>
  )
}

function ActivityMetricCard({
  label,
  value,
  sub,
  tone,
  onClick,
}: {
  label: string
  value: string
  sub: string
  tone: 'blue' | 'green' | 'orange' | 'red'
  onClick?: () => void
}) {
  const styles = {
    blue: {
      text: 'text-blue-600',
      bg: 'bg-blue-50',
      icon: 'text-blue-600',
    },
    green: {
      text: 'text-emerald-600',
      bg: 'bg-emerald-50',
      icon: 'text-emerald-600',
    },
    orange: {
      text: 'text-amber-600',
      bg: 'bg-amber-50',
      icon: 'text-amber-600',
    },
    red: {
      text: 'text-rose-600',
      bg: 'bg-rose-50',
      icon: 'text-rose-600',
    },
  }[tone]

  return (
    <div
      onClick={onClick}
      className={`rounded-[14px] border border-slate-200 bg-white p-3.5 ${
        onClick ? 'cursor-pointer transition hover:border-slate-300 hover:shadow-sm' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-[11px] font-semibold ${styles.text}`}>
            {label}
          </div>
          <div className="mt-2 text-[22px] font-extrabold text-slate-950">
            {value}
          </div>
          <div className="mt-1 text-[10px] text-slate-400">{sub}</div>
        </div>

        <div
          className={`flex h-10 w-10 items-center justify-center rounded-[12px] ${styles.bg} ${styles.icon}`}
        >
          <CalendarDays size={18} />
        </div>
      </div>
    </div>
  )
}

function CustomerOwnersChart({
  data,
  onOwnerClick,
}: {
  data: { name: string; Customers: number }[]
  onOwnerClick: (row: { name: string; Customers: number }) => void
}) {
  const max = Math.max(...data.map(row => row.Customers), 1)

  if (!data.length) {
    return (
      <div className="grid h-[250px] place-items-center text-sm text-slate-400">
        No owner data available
      </div>
    )
  }

  return (
    <div className="space-y-3 py-1">
      {data.map(row => {
        const width = Math.max((row.Customers / max) * 100, 3)

        return (
          <button
            key={row.name}
            type="button"
            onClick={() => onOwnerClick(row)}
            className="grid w-full grid-cols-[105px_minmax(0,1fr)_42px] items-center gap-3 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-slate-50"
          >
            <span
              className="truncate text-right text-[11px] font-medium text-slate-600"
              title={row.name}
            >
              {row.name}
            </span>

            <span className="h-8 overflow-hidden rounded-md bg-slate-100">
              <span
                className="block h-full rounded-md bg-indigo-600 transition-all duration-500"
                style={{ width: `${width}%` }}
              />
            </span>

            <span className="text-right text-[11px] font-extrabold text-slate-900">
              {fmtN(row.Customers)}
            </span>
          </button>
        )
      })}

      <div className="grid grid-cols-[105px_minmax(0,1fr)_42px] gap-3 px-1.5 pt-1 text-[10px] font-medium text-slate-400">
        <span />
        <div className="flex justify-between border-t border-slate-200 pt-2">
          <span>0</span>
          <span>{fmtN(max)}</span>
        </div>
        <span />
      </div>
    </div>
  )
}

function VerticalRow({
  name,
  count,
  total,
  color,
  onClick,
}: {
  name: string
  count: number
  total: number
  color: string
  onClick?: () => void
}) {
  const percentage = pct(count, total || 1)

  return (
    <div
      onClick={onClick}
      className={`grid grid-cols-[minmax(110px,1fr)_minmax(110px,1.7fr)_auto] items-center gap-3 rounded-lg ${
        onClick ? 'cursor-pointer hover:bg-slate-50' : ''
      }`}
    >
      <div className="truncate text-[11px] font-medium text-slate-700">
        {name}
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(percentage, count > 0 ? 3 : 0)}%`,
            backgroundColor: color,
          }}
        />
      </div>

      <div className="whitespace-nowrap text-right text-[11px] font-extrabold text-slate-900">
        {fmtN(count)}{' '}
        <span className="font-medium text-slate-400">({percentage}%)</span>
      </div>
    </div>
  )
}

export default function CustomersReportView() {
  const {
    label: customerLabel,
    singular: customerSingular,
    labelLower: customerLabelLower,
    singularLower: customerSingularLower,
  } = useModuleName('customers')
  const { label: leadLabel, singular: leadSingular } = useModuleName('leads')
  const { label: tenderLabel, singular: tenderSingular } = useModuleName('tenders')
  const { label: quotationLabel, singular: quotationSingular } = useModuleName('quotations')
  const { label: workOrderLabel, singular: workOrderSingular } = useModuleName('workorders')
  const [rows, setRows] = useState<any[]>([])
  const [options, setOptions] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const initialGlobalRange = useInitialGlobalDateRange()
  const [filters, setFilters] = useState<AnalyticsFilterState>(
    () => ({ ...EMPTY_ANALYTICS_FILTERS, ...initialGlobalRange }),
  )
  const [drilldown, setDrilldown] = useState<DrilldownRequest | null>(null)
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const loadData = useCallback(async (f: AnalyticsFilterState) => {
    setLoading(true)

    try {
      const res = await api.get(`/reports/customers?${toBackendParams(f)}`)
      setRows(res.data?.data || [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(filters)

    api
      .get('/reports/customers/filter-options')
      .then(r => setOptions(r.data))
      .catch(() => setOptions(null))
  }, [loadData]) // eslint-disable-line react-hooks/exhaustive-deps -- runs once on mount with the (possibly toolbar-seeded) initial filters

  const handleChange = (k: keyof AnalyticsFilterState, v: string) => {
    const next = { ...filters, [k]: v }

    setFilters(next)

    if (SERVER_KEYS.includes(k)) {
      loadData(next)
    }
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
    let out = rows


    if (filters.customer_id) {
      out = out.filter(
        r => (r.customer_name || '') === filters.customer_id,
      )
    }

    if (filters.search) {
      const q = filters.search.toLowerCase()

      out = out.filter(r =>
        Object.values(r).some(v =>
          String(v ?? '')
            .toLowerCase()
            .includes(q),
        ),
      )
    }

    return out
  }, [rows, filters.customer_id, filters.search])

  const thisMonth = new Date().toISOString().slice(0, 7)

  const newThisMonthRows = useMemo(
    () =>
      tableRows.filter(r =>
        String(r.created_at || '').startsWith(thisMonth),
      ),
    [tableRows, thisMonth],
  )
  const newThisMonth = newThisMonthRows.length

  const withPipeline = useMemo(
    () => tableRows.filter(r => num(r.open_pipeline_value) > 0),
    [tableRows],
  )

  const openPipelineValue = useMemo(
    () =>
      tableRows.reduce(
        (sum, row) => sum + num(row.open_pipeline_value),
        0,
      ),
    [tableRows],
  )

  const wonValue = useMemo(
    () => tableRows.reduce((sum, row) => sum + num(row.won_value), 0),
    [tableRows],
  )

  const atRisk = useMemo(
    () => tableRows.filter(r => healthOf(r) === 'At Risk'),
    [tableRows],
  )

  const wonRows = useMemo(
    () => tableRows.filter(r => num(r.won_value) > 0),
    [tableRows],
  )

  const healthyRows = useMemo(
    () => tableRows.filter(r => healthOf(r) === 'Healthy'),
    [tableRows],
  )

  const watchlistRows = useMemo(
    () => tableRows.filter(r => healthOf(r) === 'Watchlist'),
    [tableRows],
  )

  const topByPipeline = useMemo(
    () =>
      [...tableRows]
        .sort(
          (a, b) =>
            num(b.open_pipeline_value) +
            num(b.won_value) -
            (num(a.open_pipeline_value) + num(a.won_value)),
        )
        .map(r => ({
          ...r,
          total_value:
            num(r.open_pipeline_value) + num(r.won_value),
        })),
    [tableRows],
  )

  const byOwner = useMemo(() => {
    const m: Record<string, { count: number; pipeline: number }> = {}

    tableRows.forEach(r => {
      const owner = r.assigned_to || 'Unassigned'

      if (!m[owner]) {
        m[owner] = { count: 0, pipeline: 0 }
      }

      m[owner].count += 1
      m[owner].pipeline += num(r.open_pipeline_value)
    })

    return Object.entries(m)
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.count - a.count)
  }, [tableRows])

  // Map raw (possibly mistyped/mis-cased/whitespace-variant) vertical
  // strings to the canonical name from the Customer Segment master, so
  // e.g. "State Government" and "State Government " don't split into
  // separate buckets.
  const verticalCanonicalMap = useMemo(() => {
    const map: Record<string, string> = {}

    ;(options?.vertical_sectors || []).forEach((v: { name: string }) => {
      const cleaned = (v.name || '').trim().replace(/\s+/g, ' ')
      map[cleaned.toLowerCase()] = cleaned
    })

    return map
  }, [options])

  const normalizeVertical = useCallback(
    (raw: string) => {
      const cleaned = (raw || '')
        .replace(/ /g, ' ')
        .trim()
        .replace(/\s+/g, ' ')

      if (!cleaned) return 'Unknown'

      return verticalCanonicalMap[cleaned.toLowerCase()] || cleaned
    },
    [verticalCanonicalMap],
  )

  const byVertical = useMemo(() => {
    const m: Record<string, number> = {}

    tableRows.forEach(r => {
      const vertical = normalizeVertical(
        r.customer_vertical || r.industry || 'Unknown',
      )

      m[vertical] = (m[vertical] || 0) + 1
    })

    return Object.entries(m)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }, [tableRows, normalizeVertical])

  const health = useMemo(() => {
    const healthy = tableRows.filter(
      r => healthOf(r) === 'Healthy',
    ).length
    const watchlist = tableRows.filter(
      r => healthOf(r) === 'Watchlist',
    ).length

    return {
      healthy,
      watchlist,
      atRisk: atRisk.length,
    }
  }, [tableRows, atRisk])

  const activityRecency = useMemo(() => {
    const today = new Date()
    const buckets = {
      'Last 7 days': 0,
      'Last 30 days': 0,
      'Last 90 days': 0,
      Older: 0,
      'No activity': 0,
    }

    tableRows.forEach(r => {
      if (!r.last_activity) {
        buckets['No activity'] += 1
        return
      }

      const days = Math.floor(
        (today.getTime() -
          new Date(r.last_activity).getTime()) /
          86400000,
      )

      if (days <= 7) buckets['Last 7 days'] += 1
      else if (days <= 30) buckets['Last 30 days'] += 1
      else if (days <= 90) buckets['Last 90 days'] += 1
      else buckets.Older += 1
    })

    return buckets
  }, [tableRows])

  const activityRecencyRows = useMemo(() => {
    const today = new Date()
    const buckets: Record<string, any[]> = {
      'Last 7 days': [],
      'Last 30 days': [],
      'Last 90 days': [],
      Older: [],
      'No activity': [],
    }

    tableRows.forEach(r => {
      if (!r.last_activity) {
        buckets['No activity'].push(r)
        return
      }

      const days = Math.floor(
        (today.getTime() - new Date(r.last_activity).getTime()) / 86400000,
      )

      if (days <= 7) buckets['Last 7 days'].push(r)
      else if (days <= 30) buckets['Last 30 days'].push(r)
      else if (days <= 90) buckets['Last 90 days'].push(r)
      else buckets.Older.push(r)
    })

    return buckets
  }, [tableRows])

  const funnelStageRows: Record<string, any[]> = {
    [customerLabel]: tableRows,
    [`With ${leadLabel}`]: tableRows.filter(r => num(r.lead_count) > 0),
    [`With ${tenderLabel}`]: tableRows.filter(r => num(r.tender_count) > 0),
    [`With ${quotationLabel}`]: tableRows.filter(r => num(r.quotation_count) > 0),
    [`With ${workOrderLabel}`]: tableRows.filter(r => num(r.workorder_count) > 0),
  }

  const conversionFunnel = useMemo(
    () => [
      {
        name: customerLabel,
        value: tableRows.length,
      },
      {
        name: `With ${leadLabel}`,
        value: tableRows.filter(r => num(r.lead_count) > 0).length,
      },
      {
        name: `With ${tenderLabel}`,
        value: tableRows.filter(r => num(r.tender_count) > 0).length,
      },
      {
        name: `With ${quotationLabel}`,
        value: tableRows.filter(r => num(r.quotation_count) > 0).length,
      },
      {
        name: `With ${workOrderLabel}`,
        value: tableRows.filter(r => num(r.workorder_count) > 0).length,
      },
    ],
    [tableRows, customerLabel, leadLabel, tenderLabel, quotationLabel, workOrderLabel],
  )

  const ownerChartData = useMemo(
    () =>
      byOwner.slice(0, 6).map(owner => ({
        name: owner.name,
        Customers: owner.count,
      })),
    [byOwner],
  )

  const noActivityPipeline = useMemo(
    () =>
      tableRows.filter(
        r =>
          !r.last_activity &&
          num(r.open_pipeline_value) > 0,
      ),
    [tableRows],
  )

  const noActivityPipelineValue = useMemo(
    () =>
      noActivityPipeline.reduce(
        (sum, row) => sum + num(row.open_pipeline_value),
        0,
      ),
    [noActivityPipeline],
  )

  const cols: ColDef[] = [
    {
      key: 'customer_name',
      label: customerSingular,
      render: value => (
        <span className="font-semibold text-slate-900">
          {value || '—'}
        </span>
      ),
    },
    {
      key: 'customer_vertical',
      label: 'Segment',
      render: (value, row) => value || row.industry || '—',
    },
    {
      key: 'billing_city',
      label: 'District',
    },
    {
      key: 'billing_state',
      label: 'State',
    },
    {
      key: 'account_status',
      label: 'Status',
      render: value => {
        const colors: Record<string, string> = {
          Active:
            'border-emerald-200 bg-emerald-50 text-emerald-700',
          Inactive:
            'border-slate-200 bg-slate-100 text-slate-500',
          Prospect:
            'border-blue-200 bg-blue-50 text-blue-700',
          Churned:
            'border-rose-200 bg-rose-50 text-rose-600',
        }

        const status = String(value || '—')

        return (
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-bold ${
              colors[status] ||
              'border-slate-200 bg-slate-100 text-slate-500'
            }`}
          >
            {status}
          </span>
        )
      },
    },
    {
      key: 'account_potential',
      label: 'Potential',
      render: value => {
        const colors: Record<string, string> = {
          High: 'bg-rose-50 text-rose-600',
          Medium: 'bg-amber-50 text-amber-600',
          Low: 'bg-slate-100 text-slate-500',
        }

        const potential = String(value || '—')

        return potential !== '—' ? (
          <span
            className={`inline-flex rounded-md px-2 py-0.5 text-xs font-bold ${
              colors[potential] ||
              'bg-slate-100 text-slate-500'
            }`}
          >
            {potential}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )
      },
    },
    {
      key: 'assigned_to',
      label: 'Assigned To',
    },
    {
      key: 'group_name',
      label: 'Group',
    },
    {
      key: 'lead_count',
      label: leadLabel,
      align: 'right',
    },
    {
      key: 'tender_count',
      label: tenderLabel,
      align: 'right',
    },
    {
      key: 'quotation_count',
      label: quotationLabel,
      align: 'right',
    },
    {
      key: 'workorder_count',
      label: workOrderLabel,
      align: 'right',
    },
    {
      key: 'emdbg_count',
      label: 'EMD/BG',
      align: 'right',
    },
    {
      key: 'open_pipeline_value',
      label: 'Pipeline ₹',
      money: true,
      align: 'right',
    },
    {
      key: 'won_value',
      label: 'Won ₹',
      money: true,
      align: 'right',
    },
    {
      key: 'last_activity',
      label: 'Last Activity',
      render: value => (
        <span className="font-mono text-[11px] text-slate-500">
          {value || '—'}
        </span>
      ),
    },
  ]

  const openRow = (row: any) => {
    setDrilldown({
      entity: 'customer',
      id: row.id,
      label: row.customer_name,
      seedRow: row,
    })
  }

  const openList = (title: string, sub: string, list: any[]) => {
    setListDrill({ title, sub, rows: list, columns: cols })
  }

  if (loading && !rows.length) {
    return <TabSkeleton />
  }

  return (
    <div className="space-y-3 bg-[#f7f9fc] p-3">
      <AnalyticsFilterBar
        filters={filters}
        onChange={handleChange}
        onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() =>
          exportRows(tableRows, cols, 'customers')
        }
        filterOptions={{
          owners: options?.users,
          regions: options?.cities,
          states: options?.states,
          customers: (options?.customers || []).map(
            (name: string) => ({
              id: name,
              name,
            }),
          ),
        }}
        loading={loading}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <DashboardKpiCard
          label={`Total ${customerLabel}`}
          value={fmtN(tableRows.length)}
          sub={`Current ${customerSingularLower} base`}
          tone="primary"
          icon={<Users size={21} strokeWidth={2.1} />}
          onClick={() =>
            openList(`Total ${customerLabel}`, `Current ${customerSingularLower} base`, tableRows)
          }
        />

        <DashboardKpiCard
          label={`New ${customerLabel}`}
          value={fmtN(newThisMonth)}
          sub="Added this month"
          tone="success"
          icon={<UserPlus size={21} strokeWidth={2.1} />}
          onClick={() =>
            openList(`New ${customerLabel}`, 'Added this month', newThisMonthRows)
          }
        />

        <DashboardKpiCard
          label="Open Pipeline"
          value={fmtN(withPipeline.length)}
          sub={`${pct(
            withPipeline.length,
            tableRows.length || 1,
          )}% of ${customerLabelLower}`}
          tone="info"
          icon={<Filter size={21} strokeWidth={2.1} />}
          onClick={() =>
            openList(
              'Open Pipeline',
              `${customerLabel} with an open pipeline value`,
              withPipeline,
            )
          }
        />

        <DashboardKpiCard
          label="Open Pipeline Value"
          value={fmtRsL(openPipelineValue)}
          sub="Total active pipeline"
          tone="purple"
          icon={<WalletCards size={21} strokeWidth={2.1} />}
          onClick={() =>
            openList(
              'Open Pipeline Value',
              `${customerLabel} contributing to total active pipeline`,
              withPipeline,
            )
          }
        />

        <DashboardKpiCard
          label={`At-Risk ${customerLabel}`}
          value={fmtN(atRisk.length)}
          sub="Needs immediate attention"
          tone="danger"
          icon={<AlertTriangle size={21} strokeWidth={2.1} />}
          onClick={() =>
            openList(
              `At-Risk ${customerLabel}`,
              'Needs immediate attention',
              atRisk,
            )
          }
        />

        <DashboardKpiCard
          label="Won Value"
          value={fmtRsL(wonValue)}
          sub="Successfully converted"
          tone="success"
          icon={
            <CircleDollarSign size={21} strokeWidth={2.1} />
          }
          onClick={() =>
            openList(
              'Won Value',
              `${customerLabel} with successfully converted (won) value`,
              wonRows,
            )
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[1fr_1.15fr_0.9fr]">
        <DashboardPanel
          title="Pipeline Conversion Funnel"
          sub={`${customerSingular} → ${leadSingular} → ${tenderSingular} → ${quotationSingular} → ${workOrderSingular} → Repeat`}
        >
          <PipelineConversionCard
            title=""
            sub=""
            data={conversionFunnel}
            height={290}
            onStageClick={stage =>
              openList(
                stage.name,
                `${customerSingular} → ${leadSingular} → ${tenderSingular} → ${quotationSingular} → ${workOrderSingular} → Repeat`,
                funnelStageRows[stage.name] || [],
              )
            }
          />
        </DashboardPanel>

        <DashboardPanel
          title={`Top ${customerLabel} by Value`}
          sub="Open pipeline + won value"
        >
          <div className="space-y-3">
            {topByPipeline.slice(0, 5).map((customer, index) => {
              const max = topByPipeline[0]?.total_value || 1
              const width = Math.max(
                (num(customer.total_value) / max) * 100,
                2,
              )

              return (
                <button
                  key={customer.id || customer.customer_name || index}
                  type="button"
                  onClick={() => openRow(customer)}
                  className="w-full rounded-[14px] border border-transparent p-2 text-left transition hover:border-slate-200 hover:bg-slate-50"
                >
                  <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3">
                    <div className="text-[10px] font-bold text-slate-400">
                      {String(index + 1).padStart(2, '0')}
                    </div>

                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold text-slate-900">
                        {customer.customer_name || `Unknown ${customerSingular}`}
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-indigo-600"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </div>

                    <div className="whitespace-nowrap text-[12px] font-extrabold text-slate-900">
                      {fmtRsL(customer.total_value)}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </DashboardPanel>

        <div className="grid gap-3">
          <RiskSignalCard
            title="Open Pipeline, No Activity"
            description={`${fmtN(
              noActivityPipeline.length,
            )} ${customerLabelLower} with pipeline but no recorded activity`}
            value={fmtRsL(noActivityPipelineValue)}
            tone="red"
            onClick={() =>
              openList(
                'Open Pipeline, No Activity',
                `${customerLabel} with pipeline but no recorded activity`,
                noActivityPipeline,
              )
            }
          />

          <RiskSignalCard
            title="Inactive / Churned Accounts"
            description="Accounts marked Inactive or Churned"
            value={fmtN(atRisk.length)}
            tone="orange"
            onClick={() =>
              openList(
                'Inactive / Churned Accounts',
                'Accounts marked Inactive or Churned',
                atRisk,
              )
            }
          />

          <RiskSignalCard
            title={`New ${customerLabel} This Month`}
            description={`Recently added ${customerSingularLower} accounts`}
            value={fmtN(newThisMonth)}
            tone="green"
            onClick={() =>
              openList(
                `New ${customerLabel} This Month`,
                `Recently added ${customerSingularLower} accounts`,
                newThisMonthRows,
              )
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <DashboardPanel title={`${customerSingular} Health Score`}>
          <HealthDonut
            healthy={health.healthy}
            watchlist={health.watchlist}
            atRisk={health.atRisk}
            total={tableRows.length}
            onSegmentClick={label => {
              if (label === 'Healthy') {
                openList(`Healthy ${customerLabel}`, `${customerLabel} in good standing`, healthyRows)
              } else if (label === 'Watchlist') {
                openList(`Watchlist ${customerLabel}`, `${customerLabel} to keep an eye on`, watchlistRows)
              } else if (label === 'At Risk') {
                openList(`At-Risk ${customerLabel}`, 'Needs immediate attention', atRisk)
              }
            }}
          />
        </DashboardPanel>

        <DashboardPanel title="Activity Recency">
          <div className="grid grid-cols-2 gap-3">
            <ActivityMetricCard
              label="Last 7 Days"
              value={fmtN(activityRecency['Last 7 days'])}
              sub={`${pct(
                activityRecency['Last 7 days'],
                tableRows.length || 1,
              )}% of ${customerLabelLower}`}
              tone="blue"
              onClick={() =>
                openList(
                  'Activity: Last 7 Days',
                  `${customerLabel} with activity in the last 7 days`,
                  activityRecencyRows['Last 7 days'],
                )
              }
            />

            <ActivityMetricCard
              label="Last 30 Days"
              value={fmtN(activityRecency['Last 30 days'])}
              sub={`${pct(
                activityRecency['Last 30 days'],
                tableRows.length || 1,
              )}% of ${customerLabelLower}`}
              tone="green"
              onClick={() =>
                openList(
                  'Activity: Last 30 Days',
                  `${customerLabel} with activity in the last 30 days`,
                  activityRecencyRows['Last 30 days'],
                )
              }
            />

            <ActivityMetricCard
              label="Last 90 Days"
              value={fmtN(activityRecency['Last 90 days'])}
              sub={`${pct(
                activityRecency['Last 90 days'],
                tableRows.length || 1,
              )}% of ${customerLabelLower}`}
              tone="orange"
              onClick={() =>
                openList(
                  'Activity: Last 90 Days',
                  `${customerLabel} with activity in the last 90 days`,
                  activityRecencyRows['Last 90 days'],
                )
              }
            />

            <ActivityMetricCard
              label="Older / No Activity"
              value={fmtN(
                activityRecency.Older +
                  activityRecency['No activity'],
              )}
              sub={`${pct(
                activityRecency.Older +
                  activityRecency['No activity'],
                tableRows.length || 1,
              )}% of ${customerLabelLower}`}
              tone="red"
              onClick={() =>
                openList(
                  'Activity: Older / No Activity',
                  `${customerLabel} with older or no recorded activity`,
                  [
                    ...activityRecencyRows.Older,
                    ...activityRecencyRows['No activity'],
                  ],
                )
              }
            />
          </div>
        </DashboardPanel>

        <DashboardPanel title={`${customerSingular} by Segment`}>
          <div className="space-y-5 py-1">
            {byVertical.map((vertical, index) => (
              <VerticalRow
                key={vertical.name}
                name={vertical.name}
                count={vertical.count}
                total={tableRows.length}
                color={CHART[index % CHART.length]}
                onClick={() =>
                  openList(
                    vertical.name,
                    `${customerLabel} in this vertical`,
                    tableRows.filter(
                      r =>
                        (r.customer_vertical || r.industry || 'Unknown') ===
                        vertical.name,
                    ),
                  )
                }
              />
            ))}

            {!byVertical.length ? (
              <div className="py-10 text-center text-sm text-slate-400">
                No vertical data available
              </div>
            ) : null}

            <div className="border-t border-slate-100 pt-3 text-[11px] font-bold text-slate-700">
              Total: {fmtN(tableRows.length)} {customerLabel}
            </div>
          </div>
        </DashboardPanel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <DashboardPanel
          title={`Top ${customerLabel} by Value`}
          sub="Open pipeline + won value"
        >
          <div className="space-y-3">
            {topByPipeline.slice(0, 5).map((customer, index) => {
              const max = topByPipeline[0]?.total_value || 1
              const width = Math.max(
                (num(customer.total_value) / max) * 100,
                2,
              )

              return (
                <button
                  key={customer.id || customer.customer_name || index}
                  type="button"
                  onClick={() => openRow(customer)}
                  className="w-full rounded-[14px] border border-transparent p-2 text-left transition hover:border-slate-200 hover:bg-slate-50"
                >
                  <div className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3">
                    <div className="text-[10px] font-bold text-slate-400">
                      {String(index + 1).padStart(2, '0')}
                    </div>

                    <div className="min-w-0">
                      <div className="truncate text-[12px] font-semibold text-slate-900">
                        {customer.customer_name || `Unknown ${customerSingular}`}
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-indigo-600"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </div>

                    <div className="whitespace-nowrap text-[12px] font-extrabold text-slate-900">
                      {fmtRsL(customer.total_value)}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </DashboardPanel>

        <DashboardPanel
          title={`${customerSingular} Owners`}
          sub={`${customerSingular} count by owner`}
        >
          <CustomerOwnersChart
            data={ownerChartData}
            onOwnerClick={row =>
              openList(
                row.name,
                `${customerLabel} assigned to this owner`,
                tableRows.filter(
                  r => (r.assigned_to || 'Unassigned') === row.name,
                ),
              )
            }
          />
        </DashboardPanel>
      </div>

      <section className="overflow-hidden rounded-[18px] border border-slate-200/80 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.045)]">
        <div className="flex flex-col gap-2 border-b border-slate-100 bg-gradient-to-r from-indigo-50/80 via-white to-sky-50/70 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[13px] font-bold text-slate-900">
              {customerSingular} 360 Analytical Linkage Report
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {customerSingular}-wise linked modules and value movement — click a row
              for the 360° view
            </div>
          </div>

          <button
            type="button"
            onClick={() => loadData(filters)}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw
              size={14}
              className={loading ? 'animate-spin' : ''}
            />
            Refresh Data
          </button>
        </div>

        <div className="p-3">
          <DataTable
            data={tableRows}
            columns={cols as any}
            title={`${customerSingularLower}-360-linkage`}
            onRowClick={openRow}
            showExport
            showColumnToggle
          />
        </div>
      </section>

      <RecordViewPanel
        request={drilldown}
        onClose={() => setDrilldown(null)}
      />

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