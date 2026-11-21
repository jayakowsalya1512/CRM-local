/**
 * QuotationsReportView.tsx — Quotation Analytics report (Reports section).
 * Data source: GET /reports/quotations + /reports/quotations/filter-options.
 *
 * Design notes:
 * - No line, donut/circle or conventional bar charts in the quotation overview.
 * - Quotation Funnel is intentionally retained through PipelineConversionCard.
 * - Distribution Intelligence and Quotation Registry are intentionally unchanged.
 * - Every metric/list item supports drill-down.
 * - Hovering a visual item highlights it and fades the remaining sibling items.
 */
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  CalendarClock,
  CalendarX2,
  Check,
  CheckCheck,
  ChevronRight,
  Coins,
  FileCheck2,
  FileText,
  Hourglass,
  ShieldCheck,
  Sparkles,
  Target,
  TimerReset,
  X,
} from 'lucide-react'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  fmtN,
  fmtRsL,
  num,
  pct,
  Badge,
  Section,
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
import { RecordViewPanel } from '../report-engine/RecordViewPanel'
import { ListDrilldownModal, ListDrilldownRequest } from './shared/ListDrilldownModal'
import { DistributionSection } from './shared/DistributionCharts'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()
  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.owner) p.set('created_by', f.owner)
  if (f.status) p.set('status', f.status)
  if (f.customer_id) p.set('customer_id', f.customer_id)
  p.set('per_page', '1000')
  return p
}

const SERVER_KEYS: (keyof AnalyticsFilterState)[] = [
  'date_from',
  'date_to',
  'owner',
  'status',
  'customer_id',
]

const FUNNEL_ORDER = ['Draft', 'Sent', 'Approved', 'Accepted']

const metricTone = {
  violet: {
    shell: 'border-violet-200/80 bg-gradient-to-br from-violet-50 via-white to-white',
    icon: 'bg-violet-100 text-violet-700',
    accent: 'text-violet-700',
    hover: 'hover:border-violet-300 hover:shadow-[0_16px_36px_rgba(124,58,237,0.13)]',
  },
  emerald: {
    shell: 'border-emerald-200/80 bg-gradient-to-br from-emerald-50 via-white to-white',
    icon: 'bg-emerald-100 text-emerald-700',
    accent: 'text-emerald-700',
    hover: 'hover:border-emerald-300 hover:shadow-[0_16px_36px_rgba(5,150,105,0.13)]',
  },
  orange: {
    shell: 'border-orange-200/80 bg-gradient-to-br from-orange-50 via-white to-white',
    icon: 'bg-orange-100 text-orange-700',
    accent: 'text-orange-700',
    hover: 'hover:border-orange-300 hover:shadow-[0_16px_36px_rgba(234,88,12,0.13)]',
  },
  blue: {
    shell: 'border-blue-200/80 bg-gradient-to-br from-blue-50 via-white to-white',
    icon: 'bg-blue-100 text-blue-700',
    accent: 'text-blue-700',
    hover: 'hover:border-blue-300 hover:shadow-[0_16px_36px_rgba(37,99,235,0.13)]',
  },
} as const

type MetricTone = keyof typeof metricTone

type MetricCardProps = {
  id: string
  hovered: string | null
  onHover: (id: string | null) => void
  onClick: () => void
  icon: ReactNode
  label: string
  value: string
  sub: string
  tone: MetricTone
}

function MetricCard({
  id,
  hovered,
  onHover,
  onClick,
  icon,
  label,
  value,
  sub,
  tone,
}: MetricCardProps) {
  const t = metricTone[tone]
  const isDimmed = hovered !== null && hovered !== id
  const isActive = hovered === id

  return (
    <button
      type="button"
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(id)}
      onBlur={() => onHover(null)}
      onClick={onClick}
      className={`group relative min-h-[118px] w-full overflow-hidden rounded-2xl border p-4 text-left transition-all duration-300 ${t.shell} ${t.hover} ${
        isDimmed ? 'opacity-35 grayscale' : 'opacity-100'
      } ${isActive ? '-translate-y-1 shadow-xl' : ''}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${t.icon}`}>
          {icon}
        </div>
        <ArrowUpRight
          size={16}
          className={`transition-all duration-300 ${t.accent} ${
            isActive ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0'
          }`}
        />
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
        <p className="mt-1 text-[23px] font-black tracking-tight text-slate-950">{value}</p>
        <p className={`mt-1 text-[10.5px] font-semibold ${t.accent}`}>{sub}</p>
      </div>
    </button>
  )
}

function focusClass(hovered: string | null, id: string) {
  if (!hovered) return 'opacity-100'
  return hovered === id ? 'opacity-100' : 'opacity-30 grayscale'
}

function percentText(value: number, total: number) {
  return `${pct(value, total || 1)}%`
}

export default function QuotationsReportView() {
  const {
    label: quotationLabel,
    singular: quotationSingular,
    labelLower: quotationLabelLower,
    singularLower: quotationSingularLower,
  } = useModuleName('quotations')
  const { singular: customerSingular, singularLower: customerSingularLower } = useModuleName('customers')
  const [rows, setRows] = useState<any[]>([])
  const [options, setOptions] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const initialGlobalRange = useInitialGlobalDateRange()
  const [filters, setFilters] = useState<AnalyticsFilterState>(() => ({ ...EMPTY_ANALYTICS_FILTERS, ...initialGlobalRange }))
  const [drilldown, setDrilldown] = useState<DrilldownRequest | null>(null)
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const [hoveredKpi, setHoveredKpi] = useState<string | null>(null)
  const [hoveredComparison, setHoveredComparison] = useState<string | null>(null)
  const [hoveredCustomer, setHoveredCustomer] = useState<string | null>(null)
  const [hoveredValidity, setHoveredValidity] = useState<string | null>(null)
  const [hoveredApproval, setHoveredApproval] = useState<string | null>(null)
  const [hoveredAction, setHoveredAction] = useState<string | null>(null)

  const loadData = useCallback(async (f: AnalyticsFilterState) => {
    setLoading(true)
    try {
      const res = await api.get(`/reports/quotations?${toBackendParams(f)}`)
      setRows(res.data?.data || [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(filters)
    api.get('/reports/quotations/filter-options')
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
    return rows.filter(r =>
      Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)),
    )
  }, [rows, filters.search])

  const accepted = useMemo(
    () => tableRows.filter(r => r.status === 'Accepted'),
    [tableRows],
  )

  const aging15 = useMemo(
    () =>
      tableRows.filter(
        r =>
          r.days_to_validity != null &&
          num(r.days_to_validity) <= 15 &&
          (r.status === 'Draft' || r.status === 'Sent'),
      ),
    [tableRows],
  )

  const expiringRows = useMemo(
    () => tableRows.filter(r => r.validity_status === 'Expiring'),
    [tableRows],
  )

  const expiredRows = useMemo(
    () => tableRows.filter(r => r.validity_status === 'Expired'),
    [tableRows],
  )

  const activeValidityRows = useMemo(
    () => tableRows.filter(r => r.validity_status === 'Active'),
    [tableRows],
  )

  const revisionChurn = useMemo(
    () => tableRows.filter(r => num(r.revision_number) >= 3),
    [tableRows],
  )

  const funnelData = useMemo(
    () =>
      FUNNEL_ORDER.map(stage => ({
        name: stage,
        value: tableRows.filter(r => r.status === stage).length,
      })).filter(stage => stage.value > 0),
    [tableRows],
  )

  const funnelStageRows: Record<string, any[]> = useMemo(() => {
    const result: Record<string, any[]> = {}
    FUNNEL_ORDER.forEach(stage => {
      result[stage] = tableRows.filter(r => r.status === stage)
    })
    return result
  }, [tableRows])

  const approvalBreakdown = useMemo(() => {
    const grouped: Record<string, number> = {}
    tableRows.forEach(r => {
      const key = r.approval_status || 'none'
      grouped[key] = (grouped[key] || 0) + 1
    })

    return Object.entries(grouped)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }, [tableRows])

  const nextActionQueue = useMemo(() => {
    const agingIds = new Set(aging15.map(r => r.id))
    return tableRows
      .filter(r => r.validity_status === 'Expiring' || agingIds.has(r.id))
      .sort((a, b) => num(b.total_amount) - num(a.total_amount))
      .slice(0, 4)
  }, [tableRows, aging15])

  const quotedTotal = useMemo(
    () => tableRows.reduce((sum, row) => sum + num(row.total_amount), 0),
    [tableRows],
  )

  const acceptedValue = useMemo(
    () => accepted.reduce((sum, row) => sum + num(row.total_amount), 0),
    [accepted],
  )

  const valueAcceptanceRate = pct(acceptedValue, quotedTotal || 1)
  const averageQuotationValue = tableRows.length ? quotedTotal / tableRows.length : 0

  const topCustomers = useMemo(() => {
    const grouped: Record<string, number> = {}
    tableRows.forEach(row => {
      const customer = row.customer_name || 'Unknown'
      grouped[customer] = (grouped[customer] || 0) + num(row.total_amount)
    })

    return Object.entries(grouped)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
  }, [tableRows])

  const cols: ColDef[] = [
    {
      key: 'quotation_number',
      label: `${quotationSingular} No`,
      render: v => (
        <span className="font-mono text-[10px] text-slate-500">{v || '—'}</span>
      ),
    },
    { key: 'revision_label', label: 'Rev' },
    {
      key: 'customer_name',
      label: customerSingular,
      render: v => <span className="font-semibold text-slate-900">{v || '—'}</span>,
    },
    {
      key: 'subject',
      label: 'Subject',
      render: v => <span className="block max-w-[220px] truncate">{v || '—'}</span>,
    },
    {
      key: 'source_type',
      label: 'Source',
      render: v => (v ? <Badge text={v} tone="neutral" dot={false} /> : null),
    },
    {
      key: 'status',
      label: 'Status',
      render: v => (v ? <Badge text={v} /> : null),
    },
    {
      key: 'approval_status',
      label: 'Approval',
      render: v =>
        v ? (
          <Badge
            text={v}
            tone={
              v === 'approved'
                ? 'pos'
                : v === 'rejected'
                  ? 'neg'
                  : v === 'pending'
                    ? 'warn'
                    : 'neutral'
            }
          />
        ) : null,
    },
    { key: 'total_amount', label: 'Value ₹', money: true, align: 'right' },
    {
      key: 'valid_until',
      label: 'Valid Until',
      render: v => (
        <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span>
      ),
    },
    {
      key: 'validity_status',
      label: 'Validity',
      render: v =>
        v ? (
          <Badge
            text={v}
            tone={v === 'Expired' ? 'neg' : v === 'Expiring' ? 'warn' : 'pos'}
          />
        ) : (
          <span className="text-slate-300">—</span>
        ),
    },
    { key: 'created_by', label: 'Created By' },
  ]

  const openRow = (row: any) =>
    setDrilldown({
      entity: 'quotation',
      id: row.id,
      label: row.quotation_number,
      seedRow: row,
    })

  const openList = (title: string, sub: string, list: any[]) => {
    setListDrill({ title, sub, rows: list, columns: cols })
  }

  const approvalMeta = (name: string) => {
    if (name === 'approved') {
      return {
        icon: <Check size={14} />,
        iconClass: 'bg-emerald-100 text-emerald-700',
        markerClass: 'bg-emerald-500',
        hoverClass: 'hover:border-emerald-200 hover:bg-emerald-50/70',
      }
    }
    if (name === 'rejected') {
      return {
        icon: <X size={14} />,
        iconClass: 'bg-red-100 text-red-700',
        markerClass: 'bg-red-500',
        hoverClass: 'hover:border-red-200 hover:bg-red-50/70',
      }
    }
    if (name === 'pending') {
      return {
        icon: <Hourglass size={14} />,
        iconClass: 'bg-orange-100 text-orange-700',
        markerClass: 'bg-orange-500',
        hoverClass: 'hover:border-orange-200 hover:bg-orange-50/70',
      }
    }
    return {
      icon: <TimerReset size={14} />,
      iconClass: 'bg-blue-100 text-blue-700',
      markerClass: 'bg-blue-500',
      hoverClass: 'hover:border-blue-200 hover:bg-blue-50/70',
    }
  }

  if (loading && !rows.length) return <TabSkeleton />

  return (
    <div className="space-y-4">
      <AnalyticsFilterBar
        filters={filters}
        onChange={handleChange}
        onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() => exportRows(tableRows, cols, 'quotations')}
        filterOptions={{
          owners: options?.users,
          statuses: options?.statuses,
          customers: options?.customers,
        }}
        loading={loading}
      />

      <section className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_8px_30px_rgba(15,23,42,0.06)]">
        <div className="flex flex-col gap-3 border-b border-slate-100 bg-gradient-to-r from-white via-violet-50/45 to-blue-50/40 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-white shadow-lg shadow-violet-200">
                <FileText size={18} />
              </span>
              <div>
                <h2 className="text-[19px] font-black tracking-tight text-slate-950">
                  {quotationSingular} Analytics
                </h2>
                <p className="text-[11px] font-medium text-slate-500">
                  Value conversion, {customerSingularLower} concentration and {quotationSingularLower} follow-up intelligence
                </p>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() =>
              openList(
                `High Revision ${quotationLabel}`,
                `${quotationLabel} revised three or more times`,
                revisionChurn,
              )
            }
            className="inline-flex items-center gap-2 self-start rounded-xl border border-violet-200 bg-white px-3 py-2 text-[11px] font-bold text-violet-700 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-300 hover:bg-violet-50 hover:shadow-md lg:self-auto"
          >
            <Sparkles size={14} />
            {fmtN(revisionChurn.length)} high-revision {quotationLabelLower}
            <ChevronRight size={14} />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            id="quoted"
            hovered={hoveredKpi}
            onHover={setHoveredKpi}
            onClick={() =>
              openList('Total Quoted Value', `All ${quotationLabelLower} contributing to quoted value`, tableRows)
            }
            icon={<FileText size={22} />}
            label="Total Quoted Value"
            value={fmtRsL(quotedTotal)}
            sub={`${fmtN(tableRows.length)} ${quotationLabelLower}`}
            tone="violet"
          />

          <MetricCard
            id="accepted"
            hovered={hoveredKpi}
            onHover={setHoveredKpi}
            onClick={() =>
              openList('Accepted Value', `Accepted ${quotationLabelLower} contributing to this value`, accepted)
            }
            icon={<FileCheck2 size={22} />}
            label="Accepted Value"
            value={fmtRsL(acceptedValue)}
            sub={`${fmtN(accepted.length)} accepted ${quotationLabelLower}`}
            tone="emerald"
          />

          <MetricCard
            id="rate"
            hovered={hoveredKpi}
            onHover={setHoveredKpi}
            onClick={() =>
              openList('Acceptance Rate', `${quotationLabel} converted to accepted business`, accepted)
            }
            icon={<Target size={22} />}
            label="Acceptance Rate"
            value={`${valueAcceptanceRate}%`}
            sub="accepted value vs total quoted value"
            tone="orange"
          />

          <MetricCard
            id="average"
            hovered={hoveredKpi}
            onHover={setHoveredKpi}
            onClick={() =>
              openList(
                `Average ${quotationSingular} Value`,
                `All ${quotationLabelLower} used to calculate the average value`,
                tableRows,
              )
            }
            icon={<Coins size={22} />}
            label={`Avg. ${quotationSingular} Value`}
            value={fmtRsL(averageQuotationValue)}
            sub={`average value per ${quotationSingularLower}`}
            tone="blue"
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.02fr_1.08fr_.9fr]">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_26px_rgba(15,23,42,0.055)]">
          <div>
            <h3 className="text-[13px] font-black uppercase tracking-[0.04em] text-slate-900">
              Quoted vs Accepted Value
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">Value conversion overview</p>
          </div>

          <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
            <button
              type="button"
              onMouseEnter={() => setHoveredComparison('quoted')}
              onMouseLeave={() => setHoveredComparison(null)}
              onFocus={() => setHoveredComparison('quoted')}
              onBlur={() => setHoveredComparison(null)}
              onClick={() =>
                openList('Quoted Value', `All ${quotationLabelLower} contributing to quoted value`, tableRows)
              }
              className={`rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 to-white p-4 text-center transition-all duration-300 hover:-translate-y-0.5 hover:border-violet-300 hover:shadow-lg ${focusClass(
                hoveredComparison,
                'quoted',
              )}`}
            >
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
                <FileText size={17} />
              </div>
              <p className="mt-3 text-[9px] font-black uppercase tracking-[0.13em] text-slate-500">
                Quoted Value
              </p>
              <p className="mt-1 text-[18px] font-black text-slate-950">{fmtRsL(quotedTotal)}</p>
            </button>

            <div className="flex items-center">
              <span className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[9px] font-black uppercase tracking-wider text-slate-500 shadow-sm">
                VS
              </span>
            </div>

            <button
              type="button"
              onMouseEnter={() => setHoveredComparison('accepted')}
              onMouseLeave={() => setHoveredComparison(null)}
              onFocus={() => setHoveredComparison('accepted')}
              onBlur={() => setHoveredComparison(null)}
              onClick={() =>
                openList('Accepted Value', 'Accepted quotations contributing to this value', accepted)
              }
              className={`rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 text-center transition-all duration-300 hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-lg ${focusClass(
                hoveredComparison,
                'accepted',
              )}`}
            >
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                <CheckCheck size={17} />
              </div>
              <p className="mt-3 text-[9px] font-black uppercase tracking-[0.13em] text-slate-500">
                Accepted Value
              </p>
              <p className="mt-1 text-[18px] font-black text-slate-950">{fmtRsL(acceptedValue)}</p>
            </button>
          </div>

          <button
            type="button"
            onClick={() =>
              openList(
                'Accepted Conversion',
                'Quotations included in the accepted conversion rate',
                accepted,
              )
            }
            className="mt-4 flex w-full items-center justify-between rounded-2xl border border-violet-100 bg-gradient-to-r from-violet-50 via-white to-emerald-50 px-4 py-3 text-left transition hover:border-violet-200 hover:shadow-md"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-600 text-white shadow-md shadow-violet-200">
                <ArrowUpRight size={17} />
              </span>
              <div>
                <p className="text-[16px] font-black text-violet-700">{valueAcceptanceRate}%</p>
                <p className="text-[10px] font-semibold text-slate-500">
                  of quoted value converted to accepted business
                </p>
              </div>
            </div>
            <ChevronRight size={17} className="text-violet-500" />
          </button>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_26px_rgba(15,23,42,0.055)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-black uppercase tracking-[0.04em] text-slate-900">
                Top Customers by Quotation Value
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-500">Highest cumulative quoted value</p>
            </div>
            <button
              type="button"
              onClick={() =>
                openList('All Quotation Customers', 'All customers with quotations', tableRows)
              }
              className="text-[10px] font-bold text-violet-700 transition hover:text-violet-900"
            >
              View all
            </button>
          </div>

          <div className="mt-3 space-y-1.5">
            {topCustomers.length === 0 && (
              <p className="py-10 text-center text-xs text-slate-400">No quotations found</p>
            )}

            {topCustomers.map((customer, index) => {
              const id = `customer-${customer.name}`
              return (
                <button
                  type="button"
                  key={customer.name}
                  onMouseEnter={() => setHoveredCustomer(id)}
                  onMouseLeave={() => setHoveredCustomer(null)}
                  onFocus={() => setHoveredCustomer(id)}
                  onBlur={() => setHoveredCustomer(null)}
                  onClick={() =>
                    openList(
                      customer.name,
                      'Quotations for this customer',
                      tableRows.filter(
                        row => (row.customer_name || 'Unknown') === customer.name,
                      ),
                    )
                  }
                  className={`group flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left transition-all duration-300 hover:border-violet-200 hover:bg-violet-50 hover:shadow-sm ${focusClass(
                    hoveredCustomer,
                    id,
                  )}`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50 text-[11px] font-black text-violet-700 transition group-hover:bg-violet-600 group-hover:text-white">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-bold text-slate-800 group-hover:text-violet-900">
                      {customer.name}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      {Array.from({ length: 5 }).map((_, markerIndex) => {
                        const activeMarkers = Math.max(
                          1,
                          Math.ceil(
                            (customer.value / Math.max(topCustomers[0]?.value || 1, 1)) * 5,
                          ),
                        )
                        return (
                          <span
                            key={markerIndex}
                            className={`h-1.5 w-1.5 rotate-45 rounded-[1px] transition-all duration-300 ${
                              markerIndex < activeMarkers
                                ? 'bg-violet-500 group-hover:bg-violet-700'
                                : 'bg-slate-200'
                            }`}
                          />
                        )
                      })}
                    </div>
                  </div>
                  <span className="shrink-0 text-[11px] font-black text-slate-900">
                    {fmtRsL(customer.value)}
                  </span>
                  <ChevronRight
                    size={14}
                    className="-translate-x-1 text-violet-500 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
                  />
                </button>
              )
            })}
          </div>
        </section>

        <PipelineConversionCard
          title="Quotation Funnel"
          sub="Draft → Sent → Approved → Accepted"
          data={funnelData}
          height={330}
          onStageClick={stage =>
            openList(
              stage.name,
              'Draft → Sent → Approved → Accepted',
              funnelStageRows[stage.name] || [],
            )
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_26px_rgba(15,23,42,0.055)]">
          <div>
            <h3 className="text-[13px] font-black uppercase tracking-[0.04em] text-slate-900">
              Validity Risk
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">Quote validity window health</p>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2.5">
            {[
              {
                id: 'active',
                label: 'Active',
                value: activeValidityRows.length,
                rows: activeValidityRows,
                icon: <ShieldCheck size={17} />,
                shell: 'border-emerald-200 bg-emerald-50/75 hover:bg-emerald-100/75',
                iconClass: 'bg-emerald-100 text-emerald-700',
                valueClass: 'text-emerald-700',
              },
              {
                id: 'expiring',
                label: 'Expiring',
                value: expiringRows.length,
                rows: expiringRows,
                icon: <CalendarClock size={17} />,
                shell: 'border-amber-200 bg-amber-50/75 hover:bg-amber-100/75',
                iconClass: 'bg-amber-100 text-amber-700',
                valueClass: 'text-amber-700',
              },
              {
                id: 'expired',
                label: 'Expired',
                value: expiredRows.length,
                rows: expiredRows,
                icon: <CalendarX2 size={17} />,
                shell: 'border-red-200 bg-red-50/75 hover:bg-red-100/75',
                iconClass: 'bg-red-100 text-red-700',
                valueClass: 'text-red-700',
              },
            ].map(item => (
              <button
                type="button"
                key={item.id}
                onMouseEnter={() => setHoveredValidity(item.id)}
                onMouseLeave={() => setHoveredValidity(null)}
                onFocus={() => setHoveredValidity(item.id)}
                onBlur={() => setHoveredValidity(null)}
                onClick={() =>
                  openList(
                    `${item.label} Validity`,
                    `Quotations with ${item.label.toLowerCase()} validity`,
                    item.rows,
                  )
                }
                className={`rounded-2xl border p-3 text-left transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md ${item.shell} ${focusClass(
                  hoveredValidity,
                  item.id,
                )}`}
              >
                <span
                  className={`flex h-9 w-9 items-center justify-center rounded-xl ${item.iconClass}`}
                >
                  {item.icon}
                </span>
                <p className="mt-3 text-[9px] font-black uppercase tracking-[0.1em] text-slate-600">
                  {item.label}
                </p>
                <p className={`mt-1 text-[22px] font-black ${item.valueClass}`}>{fmtN(item.value)}</p>
                <p className="mt-0.5 text-[10px] font-semibold text-slate-500">
                  {percentText(item.value, tableRows.length)}
                </p>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => openList('All Quotations', 'Complete quotation list', tableRows)}
            className="mt-4 flex w-full items-center justify-between border-t border-slate-100 pt-3 text-[11px] font-bold text-slate-600 transition hover:text-violet-700"
          >
            <span>Total Quotes</span>
            <span className="flex items-center gap-2 text-slate-950">
              {fmtN(tableRows.length)} <ChevronRight size={14} />
            </span>
          </button>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_26px_rgba(15,23,42,0.055)]">
          <div>
            <h3 className="text-[13px] font-black uppercase tracking-[0.04em] text-slate-900">
              Approval Status
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">Internal approval workflow state</p>
          </div>

          <div className="mt-3 space-y-1.5">
            {approvalBreakdown.map(item => {
              const meta = approvalMeta(item.name)
              const id = `approval-${item.name}`
              const percentage = pct(item.count, tableRows.length || 1)
              const activeMarkers = Math.max(1, Math.round(percentage / 10))

              return (
                <button
                  type="button"
                  key={item.name}
                  onMouseEnter={() => setHoveredApproval(id)}
                  onMouseLeave={() => setHoveredApproval(null)}
                  onFocus={() => setHoveredApproval(id)}
                  onBlur={() => setHoveredApproval(null)}
                  onClick={() =>
                    openList(
                      `Approval: ${item.name}`,
                      'Quotations in this internal approval state',
                      tableRows.filter(
                        row => (row.approval_status || 'none') === item.name,
                      ),
                    )
                  }
                  className={`flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left transition-all duration-300 ${meta.hoverClass} ${focusClass(
                    hoveredApproval,
                    id,
                  )}`}
                >
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${meta.iconClass}`}
                  >
                    {meta.icon}
                  </span>
                  <span className="w-[76px] truncate text-[11px] font-bold capitalize text-slate-700">
                    {item.name}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1">
                    {Array.from({ length: 10 }).map((_, markerIndex) => (
                      <span
                        key={markerIndex}
                        className={`h-2 w-2 rotate-45 rounded-[1px] transition-all duration-300 ${
                          markerIndex < activeMarkers ? meta.markerClass : 'bg-slate-200'
                        }`}
                      />
                    ))}
                  </span>
                  <span className="shrink-0 text-[11px] font-black text-slate-900">
                    {fmtN(item.count)}
                  </span>
                  <span className="w-8 shrink-0 text-right text-[10px] font-semibold text-slate-500">
                    {percentage}%
                  </span>
                </button>
              )
            })}
          </div>

          <button
            type="button"
            onClick={() => openList('All Approval States', 'All quotations by approval state', tableRows)}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2 text-[10px] font-bold text-violet-700 transition hover:border-violet-200 hover:bg-violet-100"
          >
            View All Quotes <ChevronRight size={13} />
          </button>
        </section>

        <section className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_26px_rgba(15,23,42,0.055)]">
          <div>
            <h3 className="text-[13px] font-black uppercase tracking-[0.04em] text-slate-900">
              Next Action Queue
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Highest-value quotes needing follow-up
            </p>
          </div>

          <div className="mt-3 space-y-1.5">
            {nextActionQueue.length === 0 && (
              <div className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/60 px-4 py-8 text-center">
                <CheckCheck size={22} className="mx-auto text-emerald-600" />
                <p className="mt-2 text-[11px] font-bold text-emerald-800">
                  No expiring or aging quotations
                </p>
              </div>
            )}

            {nextActionQueue.map(row => {
              const id = `action-${row.id}`
              return (
                <button
                  type="button"
                  key={row.id}
                  onMouseEnter={() => setHoveredAction(id)}
                  onMouseLeave={() => setHoveredAction(null)}
                  onFocus={() => setHoveredAction(id)}
                  onBlur={() => setHoveredAction(null)}
                  onClick={() => openRow(row)}
                  className={`group flex w-full items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5 text-left transition-all duration-300 hover:border-violet-200 hover:bg-violet-50 hover:shadow-sm ${focusClass(
                    hoveredAction,
                    id,
                  )}`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 transition group-hover:bg-violet-600 group-hover:text-white">
                    <FileText size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-black text-slate-900">
                      {row.quotation_number} · {row.customer_name || '—'}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] font-medium text-slate-500">
                      {fmtRsL(num(row.total_amount))} · valid until {row.valid_until || '—'}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-lg border border-orange-200 bg-orange-50 px-2 py-1 text-[9px] font-black text-orange-700 transition group-hover:border-orange-300 group-hover:bg-orange-100">
                    Follow up
                  </span>
                </button>
              )
            })}
          </div>

          <button
            type="button"
            onClick={() =>
              openList(
                'Full Next Action Queue',
                'All quotations requiring follow-up',
                tableRows.filter(
                  row =>
                    row.validity_status === 'Expiring' ||
                    aging15.some(agingRow => agingRow.id === row.id),
                ),
              )
            }
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-violet-100 bg-violet-50/60 px-3 py-2 text-[10px] font-bold text-violet-700 transition hover:border-violet-200 hover:bg-violet-100"
          >
            View Full Queue <ChevronRight size={13} />
          </button>
        </section>
      </div>

      {/* Kept exactly as the existing implementation. */}
      <DistributionSection
        rows={rows}
        config={{ bu: 'lollipop', bv: 'donut', src: 'bubble', seg: 'trend' }}
        module="Quotations"
        getBU={r => r.business_vertical || 'Unclassified'}
        getBV={r =>
          r.business_vertical_group || r.business_vertical || 'Unclassified'
        }
        getSrc={r => r.source_portal || 'Other'}
        getSeg={r => r.customer_segment || 'Unclassified'}
        getResult={r =>
          r.status === 'Accepted'
            ? 'Won'
            : ['Rejected', 'Expired'].includes(r.status)
              ? 'Lost'
              : r.status || ''
        }
        getValue={r => Number(r.amount || r.total_amount || 0)}
        onOpenRows={openList}
      />

      {/* Kept exactly as the existing implementation. */}
      <Section idx="02" title="Quotation Registry" desc="Complete quotation list" />
      <DataTable
        data={tableRows}
        columns={cols as any}
        title="quotations"
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