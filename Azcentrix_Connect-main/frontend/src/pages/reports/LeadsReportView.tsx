/**
 * LeadAnalyticsView.tsx — Lead Analytics report (Reports section).
 *
 * Power BI-inspired white analytics layout.
 * Existing API calls, filters, calculations, exports, drilldown behavior,
 * and DataTable integration are preserved.
 *
 * Design changes:
 * - White background
 * - KPI cards without mini graphs
 * - No circle/donut chart
 * - No triangular funnel
 * - Uses clean horizontal bars, columns, trend chart, insight panels, and table
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C,
  fmtN,
  fmtRsL,
  num,
  pct,
  ChartTip,
  Badge,
  TabSkeleton,
  ColDef,
  AXIS_X,
  AXIS_Y,
  CGRID,
  exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import {
  AnalyticsFilterBar,
  AnalyticsFilterState,
  EMPTY_ANALYTICS_FILTERS,
} from './shared/AnalyticsFilterBar'
import { DrilldownRequest } from './shared/DrilldownDrawer'
import { RecordViewPanel } from '../report-engine/RecordViewPanel'
import {
  ListDrilldownModal,
  ListDrilldownRequest,
} from './shared/ListDrilldownModal'
import { DistributionSection } from './shared/DistributionCharts'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

// Server-side filters supported by GET /reports/leads; search stays client-side.
function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()

  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.owner) p.set('assigned_to', f.owner)
  if (f.region) p.set('region', f.region)
  if (f.status) p.set('status', f.status)
  if (f.customer_id) p.set('customer_id', f.customer_id)

  // Lead Analytics must exclude direct opportunities
  p.set('lead_type', 'lead')

  p.set('per_page', '1000')

  return p
}

const SERVER_KEYS: (keyof AnalyticsFilterState)[] = [
  'date_from',
  'date_to',
  'owner',
  'region',
  'status',
  'customer_id',
]

// Normalize /reports/leads row fields to the keys used across this view.
function normalizeRow(r: any) {
  return {
    ...r,
    ref: r.lead_ref_id,
    title: r.lead_title,
    customer: r.customer_name,
  }
}

type KpiTone = 'blue' | 'green' | 'violet' | 'amber' | 'red' | 'cyan'

const KPI_TONES: Record<
  KpiTone,
  {
    line: string
    iconBg: string
    iconText: string
    subText: string
  }
> = {
  blue: {
    line: 'bg-blue-600',
    iconBg: 'bg-blue-50',
    iconText: 'text-blue-600',
    subText: 'text-blue-600',
  },
  green: {
    line: 'bg-emerald-500',
    iconBg: 'bg-emerald-50',
    iconText: 'text-emerald-600',
    subText: 'text-emerald-600',
  },
  violet: {
    line: 'bg-violet-600',
    iconBg: 'bg-violet-50',
    iconText: 'text-violet-600',
    subText: 'text-violet-600',
  },
  amber: {
    line: 'bg-amber-500',
    iconBg: 'bg-amber-50',
    iconText: 'text-amber-600',
    subText: 'text-amber-600',
  },
  red: {
    line: 'bg-red-500',
    iconBg: 'bg-red-50',
    iconText: 'text-red-600',
    subText: 'text-red-600',
  },
  cyan: {
    line: 'bg-cyan-500',
    iconBg: 'bg-cyan-50',
    iconText: 'text-cyan-600',
    subText: 'text-cyan-600',
  },
}

function KpiIcon({
  type,
}: {
  type: 'leads' | 'new' | 'converted' | 'rate' | 'value' | 'overdue'
}) {
  const common = 'h-5 w-5'

  if (type === 'leads') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" />
        <path d="M19 8v6M22 11h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }

  if (type === 'new') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common}>
        <path d="M12 20h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    )
  }

  if (type === 'converted') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common}>
        <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (type === 'rate') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common}>
        <path d="M4 18V8M10 18V4M16 18v-7M22 18V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }

  if (type === 'value') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={common}>
        <path d="M6 3h12v18H6z" stroke="currentColor" strokeWidth="2" />
        <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" className={common}>
      <path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M10.3 3.7 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

function PowerKpi({
  label,
  value,
  sub,
  tone,
  icon,
  onClick,
}: {
  label: string
  value: string
  sub: string
  tone: KpiTone
  icon: 'leads' | 'new' | 'converted' | 'rate' | 'value' | 'overdue'
  onClick?: () => void
}) {
  const style = KPI_TONES[tone]

  return (
    <div
      onClick={onClick}
      className={`relative min-w-0 overflow-hidden rounded-[12px] border border-slate-200 bg-white px-4 py-4 shadow-[0_2px_10px_rgba(15,23,42,0.045)] ${
        onClick ? 'cursor-pointer transition hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgba(15,23,42,0.09)]' : ''
      }`}
    >
      <div className={`absolute inset-x-0 top-0 h-[3px] ${style.line}`} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[10px] font-bold uppercase tracking-[0.09em] text-slate-500">
            {label}
          </div>
          <div className="mt-2 truncate text-[26px] font-extrabold leading-none tracking-tight text-slate-950">
            {value}
          </div>
          <div className={`mt-3 truncate text-[10.5px] font-semibold ${style.subText}`}>
            {sub}
          </div>
        </div>

        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${style.iconBg} ${style.iconText}`}>
          <KpiIcon type={icon} />
        </div>
      </div>
    </div>
  )
}

function Panel({
  title,
  sub,
  children,
  className = '',
  bodyClassName = '',
}: {
  title: string
  sub?: string
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={`overflow-hidden rounded-[12px] border border-slate-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.04)] ${className}`}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <div className="text-[13px] font-bold text-slate-900">{title}</div>
          {sub ? <div className="mt-1 text-[10.5px] text-slate-500">{sub}</div> : null}
        </div>
      </div>
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
    </section>
  )
}

function MetricBar({
  label,
  value,
  max,
  displayValue,
  color = '#2563eb',
  sub,
  onClick,
}: {
  label: string
  value: number
  max: number
  displayValue: string
  color?: string
  sub?: string
  onClick?: () => void
}) {
  const width = max > 0 ? Math.max((value / max) * 100, value > 0 ? 3 : 0) : 0

  return (
    <div
      onClick={onClick}
      className={`grid grid-cols-[minmax(105px,1fr)_minmax(100px,1.7fr)_auto] items-center gap-3 rounded-lg ${
        onClick ? 'cursor-pointer hover:bg-slate-50' : ''
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-[11px] font-semibold text-slate-700">{label}</div>
        {sub ? <div className="mt-0.5 truncate text-[9.5px] text-slate-400">{sub}</div> : null}
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full"
          style={{ width: `${width}%`, backgroundColor: color }}
        />
      </div>

      <div className="whitespace-nowrap text-[11px] font-extrabold text-slate-900">
        {displayValue}
      </div>
    </div>
  )
}

function InsightRow({
  label,
  description,
  value,
  tone,
  onClick,
}: {
  label: string
  description: string
  value: string
  tone: 'red' | 'amber' | 'green' | 'blue'
  onClick?: () => void
}) {
  const styles = {
    red: {
      border: 'border-l-red-500',
      label: 'text-red-600',
      value: 'text-red-600',
      bg: 'bg-red-50/40',
    },
    amber: {
      border: 'border-l-amber-500',
      label: 'text-amber-600',
      value: 'text-amber-600',
      bg: 'bg-amber-50/40',
    },
    green: {
      border: 'border-l-emerald-500',
      label: 'text-emerald-600',
      value: 'text-emerald-600',
      bg: 'bg-emerald-50/40',
    },
    blue: {
      border: 'border-l-blue-500',
      label: 'text-blue-600',
      value: 'text-blue-600',
      bg: 'bg-blue-50/40',
    },
  }[tone]

  return (
    <div
      onClick={onClick}
      className={`rounded-[10px] border border-slate-200 border-l-[3px] px-3 py-3 ${styles.border} ${styles.bg} ${
        onClick ? 'cursor-pointer transition hover:brightness-[0.98]' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-[10.5px] font-extrabold uppercase tracking-[0.03em] ${styles.label}`}>
            {label}
          </div>
          <div className="mt-1 text-[10px] leading-4 text-slate-500">{description}</div>
        </div>
        <div className={`shrink-0 text-[18px] font-extrabold ${styles.value}`}>{value}</div>
      </div>
    </div>
  )
}

export default function LeadsReportView() {
  const {
    label: leadLabel,
    singular: leadSingular,
    labelLower: leadLabelLower,
    singularLower: leadSingularLower,
  } = useModuleName('leads')
  const { singular: customerSingular } = useModuleName('customers')
  const { singular: opportunitySingular } = useModuleName('opportunities')
  const { singular: tenderSingular } = useModuleName('tenders')
  const { singular: quotationSingular } = useModuleName('quotations')
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
      const res = await api.get(`/reports/leads?${toBackendParams(f)}`)
      setRows((res.data?.data || []).map(normalizeRow))
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(filters)

    api
      .get('/reports/leads/filter-options')
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
    if (!filters.search) return rows

    const q = filters.search.toLowerCase()

    return rows.filter(r =>
      Object.values(r).some(v =>
        String(v ?? '')
          .toLowerCase()
          .includes(q),
      ),
    )
  }, [rows, filters.search])

  const today = useMemo(() => new Date(), [])

  const convertedRows = useMemo(
    () => tableRows.filter(r => r.status === 'Converted'),
    [tableRows],
  )
  const converted = convertedRows.length

  const conversionRate = pct(converted, tableRows.length || 1)

  const pipelineRows = useMemo(
    () => tableRows.filter(r => !['Converted', 'Lost'].includes(r.status)),
    [tableRows],
  )

  const pipelineValue = useMemo(
    () => pipelineRows.reduce((sum, row) => sum + num(row.est_value), 0),
    [pipelineRows],
  )

  const overdueLeads = useMemo(
    () =>
      tableRows.filter(r => {
        if (!r.follow_up) return false

        return (
          new Date(r.follow_up) < today &&
          !['Converted', 'Lost'].includes(r.status)
        )
      }),
    [tableRows, today],
  )

  const newLeadsRows = useMemo(
    () => tableRows.filter(r => ['New', 'Assigned'].includes(r.status)),
    [tableRows],
  )
  const newLeads = newLeadsRows.length

  const assignedRows = useMemo(
    () => tableRows.filter(r => r.status === 'Assigned'),
    [tableRows],
  )
  const qualifiedRows = useMemo(
    () => tableRows.filter(r => r.status === 'Qualified'),
    [tableRows],
  )
  const opportunityRows = useMemo(
    () => tableRows.filter(r => r.status === 'Opportunity Created'),
    [tableRows],
  )

  const byOwnerGrouped = useMemo(() => {
    const m: Record<
      string,
      {
        total: number
        converted: number
        lost: number
        value: number
      }
    > = {}

    tableRows.forEach(r => {
      const owner = r.assigned_to || 'Unassigned'

      if (!m[owner]) {
        m[owner] = {
          total: 0,
          converted: 0,
          lost: 0,
          value: 0,
        }
      }

      m[owner].total += 1
      m[owner].value += num(r.est_value)

      if (r.status === 'Converted') m[owner].converted += 1
      if (r.status === 'Lost') m[owner].lost += 1
    })

    return Object.entries(m)
      .map(([name, value]) => ({
        name,
        ...value,
        rate: pct(value.converted, value.total || 1),
      }))
      .sort((a, b) => b.total - a.total)
  }, [tableRows])

  const byRegionGrouped = useMemo(() => {
    const m: Record<string, { count: number; value: number }> = {}

    tableRows.forEach(r => {
      const region = r.region || 'Unknown'

      if (!m[region]) {
        m[region] = { count: 0, value: 0 }
      }

      m[region].count += 1
      m[region].value += num(r.est_value)
    })

    return Object.entries(m)
      .map(([name, value]) => ({ name, ...value }))
      .sort((a, b) => b.value - a.value)
  }, [tableRows])

  const bySourceGrouped = useMemo(() => {
    const m: Record<string, { count: number; converted: number }> = {}

    tableRows.forEach(r => {
      const source = r.source || 'Direct'

      if (!m[source]) {
        m[source] = { count: 0, converted: 0 }
      }

      m[source].count += 1

      if (r.status === 'Converted') {
        m[source].converted += 1
      }
    })

    return Object.entries(m)
      .map(([name, value]) => ({
        name,
        ...value,
        rate: pct(value.converted, value.count || 1),
      }))
      .sort((a, b) => b.count - a.count)
  }, [tableRows])

  const statusGrouped = useMemo(() => {
    const m: Record<string, number> = {}

    tableRows.forEach(r => {
      const status = r.status || 'Unknown'
      m[status] = (m[status] || 0) + 1
    })

    const byStatus: { name: string; count: number; targetKey?: 'tender' | 'quotation' }[] =
      Object.entries(m)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)

    // Break out target_conversion (Tender / Quotation) as its own bars so the
    // panel also shows where converted leads are headed, not just raw status.
    const targetCounts: Record<string, number> = {}

    tableRows.forEach(r => {
      const target = String(r.conversion_target || '').toLowerCase()

      if (target === 'tender' || target === 'quotation') {
        targetCounts[target] = (targetCounts[target] || 0) + 1
      }
    })

    const byTarget = (['tender', 'quotation'] as const)
      .filter(target => targetCounts[target] > 0)
      .map(target => ({
        name: `Target: ${target === 'tender' ? tenderSingular : quotationSingular}`,
        count: targetCounts[target],
        targetKey: target,
      }))

    return [...byStatus, ...byTarget]
  }, [tableRows, tenderSingular, quotationSingular])

  const conversionStages = useMemo(
    () => [
      {
        key: 'Assigned',
        name: 'Assigned',
        value: assignedRows.length,
      },
      {
        key: 'Qualified',
        name: 'Qualified',
        value: qualifiedRows.length,
      },
      {
        key: 'Opportunity',
        name: opportunitySingular,
        value: opportunityRows.length,
      },
      {
        key: 'Converted',
        name: 'Converted',
        value: converted,
      },
    ],
    [assignedRows, qualifiedRows, opportunityRows, converted, opportunitySingular],
  )

  const conversionStageRows: Record<string, any[]> = {
    Assigned: assignedRows,
    Qualified: qualifiedRows,
    Opportunity: opportunityRows,
    Converted: convertedRows,
  }

  const monthlyTrend = useMemo(() => {
    const m: Record<string, { total: number; converted: number; value: number }> = {}

    tableRows.forEach(r => {
      const month = String(r.created_at || '').slice(0, 7)

      if (!month) return

      if (!m[month]) {
        m[month] = { total: 0, converted: 0, value: 0 }
      }

      m[month].total += 1
      m[month].value += num(r.est_value)

      if (r.status === 'Converted') {
        m[month].converted += 1
      }
    })

    return Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([month, value]) => ({
        month,
        leads: value.total,
        converted: value.converted,
        value: Math.round((value.value / 1e5) * 10) / 10,
      }))
  }, [tableRows])

  const byPriorityGrouped = useMemo(() => {
    const m: Record<string, { count: number; converted: number }> = {}

    tableRows.forEach(r => {
      const priority = r.priority || 'Unspecified'

      if (!m[priority]) {
        m[priority] = { count: 0, converted: 0 }
      }

      m[priority].count += 1

      if (r.status === 'Converted') {
        m[priority].converted += 1
      }
    })

    const order = ['High', 'Medium', 'Low', 'Unspecified']

    return Object.entries(m)
      .map(([name, value]) => ({
        name,
        count: value.count,
        converted: value.converted,
        rate: pct(value.converted, value.count || 1),
      }))
      .sort((a, b) => {
        const ai = order.indexOf(a.name)
        const bi = order.indexOf(b.name)

        return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
      })
  }, [tableRows])

  const bestSource = useMemo(
    () =>
      [...bySourceGrouped]
        .filter(source => source.count >= 3)
        .sort((a, b) => b.rate - a.rate)[0],
    [bySourceGrouped],
  )

  const worstOwner = useMemo(
    () =>
      [...byOwnerGrouped].sort((a, b) => {
        const aOverdue = overdueLeads.filter(
          r => (r.assigned_to || 'Unassigned') === a.name,
        ).length
        const bOverdue = overdueLeads.filter(
          r => (r.assigned_to || 'Unassigned') === b.name,
        ).length

        return bOverdue - aOverdue
      })[0],
    [byOwnerGrouped, overdueLeads],
  )

  const worstOwnerOverdue = useMemo(
    () =>
      worstOwner
        ? overdueLeads.filter(
            r => (r.assigned_to || 'Unassigned') === worstOwner.name,
          ).length
        : 0,
    [worstOwner, overdueLeads],
  )

  const stuckHighValue = useMemo(
    () =>
      tableRows.filter(
        r => num(r.est_value) >= 1000000 && overdueLeads.includes(r),
      ),
    [tableRows, overdueLeads],
  )

  const maxStage = Math.max(...conversionStages.map(stage => stage.value), 1)
  const maxOwner = Math.max(...byOwnerGrouped.map(owner => owner.total), 1)
  const maxStatus = Math.max(...statusGrouped.map(status => status.count), 1)
  const maxRegionValue = Math.max(...byRegionGrouped.map(region => region.value), 1)
  const maxPriority = Math.max(...byPriorityGrouped.map(priority => priority.count), 1)

  const cols: ColDef[] = [
    {
      key: 'ref',
      label: 'Ref',
      render: value => (
        <span className="font-mono text-[10px] text-slate-400">
          {value || '—'}
        </span>
      ),
    },
    {
      key: 'title',
      label: leadSingular,
      render: value => (
        <span className="block max-w-[200px] truncate font-semibold text-slate-900">
          {value || '—'}
        </span>
      ),
    },
    {
      key: 'customer',
      label: customerSingular,
    },
    {
      key: 'status',
      label: 'Status',
      render: value => (value ? <Badge text={value} /> : null),
    },
    {
      key: 'priority',
      label: 'Priority',
      render: value =>
        value ? (
          <Badge
            text={value}
            tone={
              value === 'High'
                ? 'neg'
                : value === 'Low'
                  ? 'neutral'
                  : 'warn'
            }
            dot={false}
          />
        ) : null,
    },
    {
      key: 'est_value',
      label: 'Value ₹',
      money: true,
      align: 'right',
    },
    {
      key: 'region',
      label: 'Region',
    },
    {
      key: 'source',
      label: 'Source',
    },
    {
      key: 'assigned_to',
      label: 'Owner',
    },
    {
      key: 'follow_up',
      label: 'Follow-up',
      render: value => (
        <span className="font-mono text-[11px] text-slate-500">
          {value || '—'}
        </span>
      ),
    },
  ]

  const openRow = (row: any) => {
    setDrilldown({
      entity: 'lead',
      id: row.id,
      label: row.title,
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
    <div className="space-y-3 bg-[#f6f8fb] p-3">
      <AnalyticsFilterBar
        filters={filters}
        onChange={handleChange}
        onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() => exportRows(tableRows, cols, 'leads')}
        filterOptions={{
          owners: options?.users,
          regions: Array.from(
            new Set(rows.map(r => r.region).filter(Boolean)),
          ) as string[],
          statuses: options?.statuses,
          customers: options?.customers,
        }}
        loading={loading}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <PowerKpi
          label="Total Leads"
          value={fmtN(tableRows.length)}
          sub="Current filtered lead base"
          tone="violet"
          icon="leads"
          onClick={() =>
            openList('Total Leads', 'Current filtered lead base', tableRows)
          }
        />

        <PowerKpi
          label="New Leads"
          value={fmtN(newLeads)}
          sub={`${pct(newLeads, tableRows.length || 1)}% of total leads`}
          tone="green"
          icon="new"
          onClick={() =>
            openList('New Leads', 'Leads currently New or Assigned', newLeadsRows)
          }
        />

        <PowerKpi
          label="Converted Leads"
          value={fmtN(converted)}
          sub={`${conversionRate}% conversion`}
          tone="blue"
          icon="converted"
          onClick={() =>
            openList('Converted Leads', 'Leads that reached Converted status', convertedRows)
          }
        />

        <PowerKpi
          label="Conversion Rate"
          value={`${conversionRate}%`}
          sub={`${fmtN(converted)} of ${fmtN(tableRows.length)} leads`}
          tone="amber"
          icon="rate"
          onClick={() =>
            openList('Conversion Rate', 'Leads that reached Converted status', convertedRows)
          }
        />

        <PowerKpi
          label="Pipeline Value"
          value={fmtRsL(pipelineValue)}
          sub="Open lead opportunity value"
          tone="cyan"
          icon="value"
          onClick={() =>
            openList('Pipeline Value', 'Leads contributing to open pipeline value', pipelineRows)
          }
        />

        <PowerKpi
          label="Overdue Follow-ups"
          value={fmtN(overdueLeads.length)}
          sub="Needs immediate attention"
          tone="red"
          icon="overdue"
          onClick={() =>
            openList('Overdue Follow-ups', 'Open leads with an overdue follow-up date', overdueLeads)
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[0.85fr_1.15fr_1.25fr]">
        <Panel
          title="Lead Stage Progress"
          sub="Conversion movement without funnel shapes"
        >
          <div className="space-y-5 py-1">
            {conversionStages.map((stage, index) => (
              <MetricBar
                key={stage.name}
                label={stage.name}
                value={stage.value}
                max={maxStage}
                displayValue={`${fmtN(stage.value)} (${pct(
                  stage.value,
                  tableRows.length || 1,
                )}%)`}
                color={['#4f46e5', '#2563eb', '#f59e0b', '#10b981'][index]}
                onClick={() =>
                  openList(
                    stage.name,
                    'Leads currently at this stage',
                    conversionStageRows[stage.name] || [],
                  )
                }
              />
            ))}
          </div>
        </Panel>

        <Panel
          title="Monthly Pipeline Value"
          sub="Estimated lead value by month (₹L)"
        >
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={monthlyTrend}
                margin={{ top: 12, right: 10, bottom: 4, left: -12 }}
              >
                <CartesianGrid {...CGRID} vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ ...AXIS_X, fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_Y}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <RechartsTooltip content={<ChartTip />} />
                <Bar
                  dataKey="value"
                  name="Pipeline Value (₹L)"
                  fill="#4f46e5"
                  radius={[5, 5, 0, 0]}
                  maxBarSize={32}
                  cursor="pointer"
                  onClick={(bar: any) =>
                    openList(
                      bar.month,
                      'Leads created in this month',
                      tableRows.filter(r => String(r.created_at || '').slice(0, 7) === bar.month),
                    )
                  }
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>

        <Panel
          title="Lead Trend"
          sub="Monthly new leads and converted leads"
        >
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={monthlyTrend}
                margin={{ top: 12, right: 10, bottom: 4, left: -12 }}
              >
                <CartesianGrid {...CGRID} vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ ...AXIS_X, fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={AXIS_Y}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <RechartsTooltip content={<ChartTip />} />
                <Line
                  type="monotone"
                  dataKey="leads"
                  name="New Leads"
                  stroke="#2563eb"
                  strokeWidth={2.2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="converted"
                  name="Converted Leads"
                  stroke="#10b981"
                  strokeWidth={2.2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_0.9fr_1fr]">
        <Panel
          title="Top Lead Owners"
          sub="Lead count, conversion, and pipeline ownership"
        >
          <div className="space-y-4">
            {byOwnerGrouped.slice(0, 6).map(owner => (
              <MetricBar
                key={owner.name}
                label={owner.name}
                value={owner.total}
                max={maxOwner}
                displayValue={fmtN(owner.total)}
                color="#4f46e5"
                sub={`${fmtN(owner.converted)} converted • ${owner.rate}%`}
                onClick={() =>
                  openList(
                    owner.name,
                    'Leads assigned to this owner',
                    tableRows.filter(r => (r.assigned_to || 'Unassigned') === owner.name),
                  )
                }
              />
            ))}
          </div>
        </Panel>

        <Panel
          title="Leads by Status"
          sub="Current lead distribution"
        >
          <div className="space-y-4">
            {statusGrouped.slice(0, 7).map((status, index) => (
              <MetricBar
                key={status.name}
                label={status.name}
                value={status.count}
                max={maxStatus}
                displayValue={`${fmtN(status.count)} (${pct(
                  status.count,
                  tableRows.length || 1,
                )}%)`}
                color={
                  [
                    '#2563eb',
                    '#10b981',
                    '#f59e0b',
                    '#8b5cf6',
                    '#ef4444',
                    '#0ea5e9',
                    '#64748b',
                  ][index % 7]
                }
                onClick={() => {
                  const targetMatch = status.name.match(/^Target: (Tender|Quotation)$/)

                  return openList(
                    status.name,
                    targetMatch ? 'Leads heading toward this conversion target' : 'Leads currently in this status',
                    targetMatch
                      ? tableRows.filter(r => String(r.conversion_target || '').toLowerCase() === targetMatch[1].toLowerCase())
                      : tableRows.filter(r => (r.status || 'Unknown') === status.name),
                  )
                }}
              />
            ))}
          </div>
        </Panel>

        <Panel
          title="Risk & Insights"
          sub="Actionable lead intelligence"
        >
          <div className="space-y-3">
            <InsightRow
              label="High Value Stuck Leads"
              description="Leads worth ₹10L or more with overdue follow-up"
              value={fmtN(stuckHighValue.length)}
              tone="red"
              onClick={() =>
                openList(
                  'High Value Stuck Leads',
                  'Leads worth ₹10L or more with overdue follow-up',
                  stuckHighValue,
                )
              }
            />

            <InsightRow
              label="Overdue Follow-ups"
              description="Open leads that need immediate action"
              value={fmtN(overdueLeads.length)}
              tone="amber"
              onClick={() =>
                openList(
                  'Overdue Follow-ups',
                  'Open leads that need immediate action',
                  overdueLeads,
                )
              }
            />

            <InsightRow
              label="Best Converting Source"
              description={
                bestSource
                  ? `${bestSource.name} currently leads conversion`
                  : 'Insufficient source data'
              }
              value={bestSource ? `${bestSource.rate}%` : '—'}
              tone="green"
              onClick={
                bestSource
                  ? () =>
                      openList(
                        bestSource.name,
                        'Leads from the best converting source',
                        tableRows.filter(r => (r.source || 'Direct') === bestSource.name),
                      )
                  : undefined
              }
            />

            <InsightRow
              label="Owner With Most Overdue"
              description={worstOwner?.name || 'No overdue owner'}
              value={fmtN(worstOwnerOverdue)}
              tone="blue"
              onClick={
                worstOwner
                  ? () =>
                      openList(
                        worstOwner.name,
                        'Overdue leads owned by this person',
                        overdueLeads.filter(
                          r => (r.assigned_to || 'Unassigned') === worstOwner.name,
                        ),
                      )
                  : undefined
              }
            />
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Panel
          title="Leads by Priority"
          sub="Volume and conversion rate by priority"
        >
          <div className="space-y-4">
            {byPriorityGrouped.map(priority => (
              <MetricBar
                key={priority.name}
                label={priority.name}
                value={priority.count}
                max={maxPriority}
                displayValue={`${priority.rate}%`}
                color={
                  priority.name === 'High'
                    ? '#ef4444'
                    : priority.name === 'Medium'
                    ? '#f59e0b'
                    : priority.name === 'Low'
                    ? '#10b981'
                    : '#64748b'
                }
                sub={`${fmtN(priority.count)} leads • ${fmtN(
                  priority.converted,
                )} converted`}
                onClick={() =>
                  openList(
                    priority.name,
                    'Leads at this priority',
                    tableRows.filter(r => (r.priority || 'Unspecified') === priority.name),
                  )
                }
              />
            ))}
          </div>
        </Panel>

        <Panel
          title="Regional Pipeline Performance"
          sub="Regions ranked by estimated lead value"
        >
          <div className="space-y-4">
            {byRegionGrouped.slice(0, 7).map(region => (
              <MetricBar
                key={region.name}
                label={region.name}
                value={region.value}
                max={maxRegionValue}
                displayValue={fmtRsL(region.value)}
                color="#2563eb"
                sub={`${fmtN(region.count)} leads`}
                onClick={() =>
                  openList(
                    region.name,
                    'Leads in this region',
                    tableRows.filter(r => (r.region || 'Unknown') === region.name),
                  )
                }
              />
            ))}
          </div>
        </Panel>
      </div>

      <DistributionSection
        rows={rows}
        config={{ bu: 'lollipop', bv: 'bubble', src: 'donut', seg: 'trend' }}
        module="Leads"
        getBU={r => r.business_vertical || 'Unclassified'}
        getBV={r => r.business_vertical_group || r.business_vertical || 'Unclassified'}
        getSrc={r => r.source || 'Other'}
        getSeg={r => r.customer_segment || 'Unclassified'}
        getResult={r => r.status === 'Converted' ? 'Converted' : r.status === 'Lost' ? 'Lost' : r.status || ''}
        getValue={r => Number(r.est_value || 0)}
        onOpenRows={openList}
      />

      <section className="overflow-hidden rounded-[12px] border border-slate-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[13px] font-bold text-slate-900">
              Lead Registry
            </div>
            <div className="mt-1 text-[10.5px] text-slate-500">
              Complete lead list — click a row for details
            </div>
          </div>

          <div className="text-[10.5px] font-semibold text-slate-400">
            {fmtN(tableRows.length)} records
          </div>
        </div>

        <div className="p-3">
          <DataTable
            data={tableRows}
            columns={cols as any}
            title="leads"
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
