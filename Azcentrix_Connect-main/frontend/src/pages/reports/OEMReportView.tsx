/**
 * OEMReportView.tsx — OEM Partner Analytics report (Reports section).
 * Data source: GET /reports/oem (reports_router.py) — one row per OEM aggregated across
 * leads, tenders, quotations and work orders.
 *
 * Redesigned as a compact OEM intelligence dashboard:
 * - KPI strip
 * - OEM contribution donut
 * - Funnel Presence by OEM retained as a stacked horizontal bar chart
 * - Tender win-rate leaderboard
 * - Interactive engagement matrix
 * - Portfolio risk snapshot
 *
 * Hover behaviour:
 * - The hovered chart item remains in full colour.
 * - All non-hovered chart items fade to a light opacity.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C,
  CHART,
  fmtN,
  fmtRsL,
  num,
  pct,
  Badge,
  ChartTip,
  Section,
  TabSkeleton,
  ColDef,
  ResponsiveContainer,
  exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import { InsightItem } from '../dashboard/tabs/InsightCard'
import {
  AnalyticsFilterBar,
  AnalyticsFilterState,
  EMPTY_ANALYTICS_FILTERS,
} from './shared/AnalyticsFilterBar'
import {
  ListDrilldownModal,
  ListDrilldownRequest,
} from './shared/ListDrilldownModal'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()
  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  return p
}

const SERVER_KEYS: (keyof AnalyticsFilterState)[] = ['date_from', 'date_to']
// Raw engagement-matrix column keys — also used as switch/lookup identifiers in
// heatmapCell() below, so these values themselves must stay fixed. Use
// engageColLabel() (defined inside the component) wherever these are rendered.
const ENGAGE_COLS = ['Leads', 'Opportunities', 'Tenders', 'Quotations', 'Work Orders']

type FunnelHover = {
  rowIndex: number
  dataKey: string
} | null

type HeatHover = {
  row: string
  col: string
} | null

type DashboardIcon = 'cube' | 'pipeline' | 'order' | 'preferred'

function MetricIcon({ type }: { type: DashboardIcon }) {
  if (type === 'cube') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
        <path d="m4.3 7.7 7.7 4.4 7.7-4.4M12 12.1V21" />
      </svg>
    )
  }

  if (type === 'pipeline') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M5 4h10l4 4v12H5V4Z" />
        <path d="M15 4v4h4M8 13h8M8 17h5" />
        <circle cx="17.5" cy="17.5" r="2.5" />
      </svg>
    )
  }

  if (type === 'order') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 3h10v3h3v15H4V6h3V3Z" />
        <path d="M9 3h6v4H9zM8 12h8M8 16h5" />
        <path d="m15.5 17 1.5 1.5 3-3" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 12h4l2.2-5 4.2 10 2.2-5H21" />
      <path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" opacity=".35" />
    </svg>
  )
}

function MetricCard({
  label,
  value,
  helper,
  icon,
  tone,
  onClick,
}: {
  label: string
  value: string
  helper: string
  icon: DashboardIcon
  tone: 'violet' | 'emerald' | 'amber' | 'blue'
  onClick: () => void
}) {
  const toneClass = {
    violet: 'from-indigo-600 to-violet-500 shadow-indigo-200/70',
    emerald: 'from-emerald-600 to-teal-500 shadow-emerald-200/70',
    amber: 'from-amber-500 to-orange-500 shadow-amber-200/70',
    blue: 'from-blue-600 to-cyan-500 shadow-blue-200/70',
  }[tone]

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[94px] w-full items-center gap-4 rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 text-left shadow-[0_4px_16px_rgba(15,23,42,0.05)] transition duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_10px_24px_rgba(15,23,42,0.09)]"
    >
      <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow-lg ${toneClass}`}>
        <MetricIcon type={icon} />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-bold uppercase tracking-[0.08em] text-slate-500">
          {label}
        </span>
        <span className="mt-0.5 block truncate text-[23px] font-bold leading-none tracking-tight text-slate-950">
          {value}
        </span>
        <span className="mt-2 block truncate text-[10.5px] font-medium text-slate-500 group-hover:text-slate-700">
          {helper}
        </span>
      </span>
    </button>
  )
}

function DashboardCard({
  title,
  sub,
  children,
  footer,
  className = '',
}: {
  title: string
  sub?: string
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)] ${className}`}>
      <div className="px-4 pb-2 pt-4">
        <div className="text-[13px] font-semibold tracking-tight text-slate-950">{title}</div>
        {sub ? <div className="mt-1 text-[10.5px] text-slate-500">{sub}</div> : null}
      </div>
      {children}
      {footer ? <div className="px-4 pb-4 pt-2">{footer}</div> : null}
    </div>
  )
}

function ActionFooter({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center justify-between rounded-lg border border-slate-200 bg-slate-50/70 px-3 text-[10.5px] font-semibold text-indigo-600 transition hover:border-indigo-200 hover:bg-indigo-50"
    >
      <span>{label}</span>
      <span aria-hidden>→</span>
    </button>
  )
}

export default function OEMReportView() {
  const {
    label: oemLabel,
    singular: oemSingular,
    labelLower: oemLabelLower,
    singularLower: oemSingularLower,
  } = useModuleName('oems')
  const { label: leadsLabel, labelLower: leadsLabelLower, singularLower: leadSingularLower } = useModuleName('leads')
  const { label: opportunitiesLabel, labelLower: opportunitiesLabelLower } = useModuleName('opportunities')
  const {
    label: tendersLabel,
    labelLower: tendersLabelLower,
    singular: tenderSingular,
    singularLower: tenderSingularLower,
  } = useModuleName('tenders')
  const {
    label: quotationsLabel,
    labelLower: quotationsLabelLower,
    singularLower: quotationSingularLower,
  } = useModuleName('quotations')
  const {
    label: workordersLabel,
    labelLower: workordersLabelLower,
    singular: workorderSingular,
    singularLower: workorderSingularLower,
  } = useModuleName('workorders')

  const funnelBars = useMemo(
    () => [
      { dataKey: 'Leads', name: leadsLabel, color: C.info },
      { dataKey: 'Tenders', name: tendersLabel, color: C.primary },
      { dataKey: 'Quotations', name: quotationsLabel, color: C.warn },
      { dataKey: 'Work Orders', name: workordersLabel, color: C.pos },
    ],
    [leadsLabel, tendersLabel, quotationsLabel, workordersLabel],
  )

  // Maps the raw ENGAGE_COLS keys to their dynamic display labels without
  // touching the raw keys used for heatmapCell() lookups.
  const engageColLabel = useCallback(
    (col: string) => {
      switch (col) {
        case 'Leads':
          return leadsLabel
        case 'Opportunities':
          return opportunitiesLabel
        case 'Tenders':
          return tendersLabel
        case 'Quotations':
          return quotationsLabel
        case 'Work Orders':
          return workordersLabel
        default:
          return col
      }
    },
    [leadsLabel, opportunitiesLabel, tendersLabel, quotationsLabel, workordersLabel],
  )

  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const initialGlobalRange = useInitialGlobalDateRange()
  const [filters, setFilters] = useState<AnalyticsFilterState>(() => ({ ...EMPTY_ANALYTICS_FILTERS, ...initialGlobalRange }))
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const [hoveredShare, setHoveredShare] = useState<string | null>(null)
  const [hoveredFunnel, setHoveredFunnel] = useState<FunnelHover>(null)
  const [hoveredWin, setHoveredWin] = useState<string | null>(null)
  const [hoveredHeat, setHoveredHeat] = useState<HeatHover>(null)

  const loadData = useCallback(async (f: AnalyticsFilterState) => {
    setLoading(true)
    try {
      const res = await api.get(`/reports/oem?${toBackendParams(f)}`)
      setRows(res.data?.data || [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(filters)
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

  const totalPipeline = useMemo(
    () => tableRows.reduce((s, r) => s + num(r.pipeline_value), 0),
    [tableRows],
  )
  const totalWoValue = useMemo(
    () => tableRows.reduce((s, r) => s + num(r.wo_value), 0),
    [tableRows],
  )
  const preferredRows = useMemo(
    () => tableRows.filter(r => num(r.preferred_count) > 0),
    [tableRows],
  )
  const preferredCount = preferredRows.length
  const activeOems = useMemo(
    () => tableRows.filter(r => num(r.total_count) > 0),
    [tableRows],
  )
  const pipelineRows = useMemo(
    () => tableRows.filter(r => num(r.pipeline_value) > 0),
    [tableRows],
  )
  const woRevenueRows = useMemo(
    () => tableRows.filter(r => num(r.wo_value) > 0),
    [tableRows],
  )

  const byContribution = useMemo(
    () =>
      [...tableRows]
        .map(r => ({
          ...r,
          contribution: num(r.pipeline_value) + num(r.wo_value),
        }))
        .sort((a, b) => b.contribution - a.contribution),
    [tableRows],
  )

  const valueShare = useMemo(() => {
    const contributors = byContribution.filter(r => r.contribution > 0)
    const top = contributors.slice(0, 6).map((r, i) => ({
      name: r.oem_name,
      value: r.contribution,
      fill: CHART[i % CHART.length],
    }))
    const rest = contributors.slice(6).reduce((s, r) => s + r.contribution, 0)
    if (rest > 0) top.push({ name: 'Others', value: rest, fill: C.ink4 })
    return top
  }, [byContribution])

  const funnelPresence = useMemo(
    () =>
      [...tableRows]
        .sort((a, b) => num(b.total_count) - num(a.total_count))
        .slice(0, 8)
        .map(r => ({
          name: r.oem_name,
          Leads: num(r.lead_count),
          Tenders: num(r.tender_count),
          Quotations: num(r.quotation_count),
          'Work Orders': num(r.wo_count),
        })),
    [tableRows],
  )

  const winRateBoard = useMemo(
    () =>
      tableRows
        .map(r => ({
          name: r.oem_name,
          decided: num(r.tender_won_count) + num(r.tender_lost_count),
          rate: pct(
            num(r.tender_won_count),
            num(r.tender_won_count) + num(r.tender_lost_count),
          ),
          won: num(r.tender_won_count),
        }))
        .filter(r => r.decided > 0)
        .sort((a, b) => b.rate - a.rate || b.won - a.won)
        .slice(0, 6),
    [tableRows],
  )

  const heatmapOems = useMemo(
    () =>
      [...tableRows]
        .sort((a, b) => num(b.total_count) - num(a.total_count))
        .slice(0, 6)
        .map(r => r.oem_name),
    [tableRows],
  )

  const heatmapCell = useCallback(
    (oem: string, col: string) => {
      const r = tableRows.find(x => x.oem_name === oem)
      if (!r) return 0
      switch (col) {
        case 'Leads':
          return num(r.lead_count)
        case 'Opportunities':
          return num(r.opportunity_count)
        case 'Tenders':
          return num(r.tender_count)
        case 'Quotations':
          return num(r.quotation_count)
        case 'Work Orders':
          return num(r.wo_count)
        default:
          return 0
      }
    },
    [tableRows],
  )

  const maxHeatValue = useMemo(() => {
    let max = 0
    heatmapOems.forEach(oem => {
      ENGAGE_COLS.forEach(col => {
        max = Math.max(max, heatmapCell(oem, col))
      })
    })
    return max || 1
  }, [heatmapOems, heatmapCell])

  const stalledRows = useMemo(
    () => tableRows.filter(r => num(r.quotation_pending_count) > 0 && num(r.wo_count) === 0),
    [tableRows],
  )
  const dormantRows = useMemo(
    () => tableRows.filter(r => num(r.total_count) === 0),
    [tableRows],
  )

  // Shared title strings — reused for both the insight card's own title and
  // the isDependency/isPending routing check further down, so the two never
  // drift apart when a module gets renamed.
  const pendingTitle = `${quotationsLabel} pending, no ${workordersLabelLower}`
  const dormantTitle = `Dormant ${oemLabel}`

  const insights: InsightItem[] = useMemo(() => {
    const items: InsightItem[] = []
    const top = byContribution[0]
    if (top && top.contribution > 0) {
      items.push({
        title: 'Dependency concentration',
        tone:
          pct(top.contribution, totalPipeline + totalWoValue) > 50
            ? 'warn'
            : 'info',
        detail: `${top.oem_name} holds the largest share of ${oemSingular}-linked business`,
        value: `${pct(top.contribution, (totalPipeline + totalWoValue) || 1)}%`,
      })
    }
    items.push({
      title: pendingTitle,
      tone: stalledRows.length ? 'warn' : 'pos',
      detail: `${oemLabel} with pending ${quotationsLabelLower} but no ${workordersLabelLower} yet`,
      value: fmtN(stalledRows.length),
    })
    items.push({
      title: dormantTitle,
      tone: dormantRows.length ? 'neg' : 'pos',
      detail: `Master ${oemLabelLower} with no ${leadSingularLower} or ${tenderSingularLower} presence in this period`,
      value: fmtN(dormantRows.length),
    })
    return items
  }, [
    byContribution,
    totalPipeline,
    totalWoValue,
    stalledRows,
    dormantRows,
    oemSingular,
    oemLabel,
    oemLabelLower,
    quotationsLabelLower,
    workordersLabelLower,
    leadSingularLower,
    tenderSingularLower,
    pendingTitle,
    dormantTitle,
  ])

  const cols: ColDef[] = [
    {
      key: 'oem_name',
      label: 'OEM',
      render: v => <span className="font-semibold text-slate-900">{v || '—'}</span>,
    },
    { key: 'lead_count', label: 'Leads', align: 'right' },
    { key: 'tender_count', label: 'Tenders', align: 'right' },
    { key: 'tender_won_count', label: 'Won', align: 'right' },
    { key: 'tender_lost_count', label: 'Lost', align: 'right' },
    { key: 'quotation_count', label: 'Quotations', align: 'right' },
    { key: 'wo_count', label: 'WOs', align: 'right' },
    { key: 'pipeline_value', label: 'Pipeline ₹', money: true, align: 'right' },
    { key: 'wo_value', label: 'WO Revenue ₹', money: true, align: 'right' },
    {
      key: 'preferred_count',
      label: 'Preferred',
      align: 'right',
      render: v =>
        num(v) > 0 ? (
          <Badge text={`${fmtN(num(v))}×`} tone="pos" dot={false} />
        ) : (
          <span className="text-slate-300">—</span>
        ),
    },
    {
      key: 'associated_products',
      label: 'Products',
      render: v => (
        <span className="block max-w-[180px] truncate text-[11px] text-slate-500">
          {v || '—'}
        </span>
      ),
    },
    {
      key: 'last_seen',
      label: 'Last Seen',
      render: v => <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span>,
    },
  ]

  const openList = (title: string, sub: string, list: any[]) => {
    setListDrill({ title, sub, rows: list, columns: cols })
  }

  const topContribution = valueShare[0]
  const topContributionPct = topContribution
    ? pct(topContribution.value, (totalPipeline + totalWoValue) || 1)
    : 0

  const getHeatCellStyle = (value: number, isFocused: boolean, isDimmed: boolean) => {
    const strength = Math.max(0.16, value / maxHeatValue)
    return {
      backgroundColor: `rgba(79, 70, 229, ${0.16 + strength * 0.74})`,
      color: strength > 0.48 ? '#ffffff' : '#312e81',
      opacity: isDimmed ? 0.2 : 1,
      transform: isFocused ? 'scale(1.04)' : 'scale(1)',
      boxShadow: isFocused ? '0 8px 20px rgba(79,70,229,0.23)' : 'none',
      zIndex: isFocused ? 2 : 1,
    } as React.CSSProperties
  }

  if (loading && !rows.length) return <TabSkeleton />

  return (
    <div className="space-y-4 pb-2">
      <AnalyticsFilterBar
        filters={filters}
        onChange={handleChange}
        onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() => exportRows(tableRows, cols, 'oem-partners')}
        filterOptions={{}}
        loading={loading}
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active OEMs"
          value={fmtN(activeOems.length)}
          helper="OEMs with funnel activity"
          icon="cube"
          tone="violet"
          onClick={() =>
            openList(
              'Active OEMs',
              'OEMs with lead, tender, quotation or work-order presence',
              activeOems,
            )
          }
        />
        <MetricCard
          label="Pipeline Value"
          value={fmtRsL(totalPipeline)}
          helper="Open OEM-linked pipeline"
          icon="pipeline"
          tone="emerald"
          onClick={() =>
            openList('Pipeline Value', 'OEMs contributing to total open pipeline', pipelineRows)
          }
        />
        <MetricCard
          label="Work Order Value"
          value={fmtRsL(totalWoValue)}
          helper="Converted OEM-linked value"
          icon="order"
          tone="amber"
          onClick={() =>
            openList(
              'Work Order Value',
              'OEMs contributing to total work-order value',
              woRevenueRows,
            )
          }
        />
        <MetricCard
          label="Preferred OEMs"
          value={fmtN(preferredCount)}
          helper="Preferred master relationships"
          icon="preferred"
          tone="blue"
          onClick={() => openList('Preferred OEMs', 'OEMs marked as preferred', preferredRows)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.92fr_1.28fr]">
        <DashboardCard
          title="OEM Pipeline Contribution"
          sub="Share of pipeline + work-order value · top 6 + others"
          className="min-h-[330px]"
          footer={
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-[10.5px]">
              <span className="font-semibold text-slate-500">Total OEMs</span>
              <span className="font-bold tabular-nums text-slate-900">{fmtN(tableRows.length)}</span>
            </div>
          }
        >
          {valueShare.length ? (
            <div className="grid min-h-[238px] grid-cols-1 items-center px-3 pb-1 sm:grid-cols-[1.15fr_0.85fr]">
              <div className="h-[230px] min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart onMouseLeave={() => setHoveredShare(null)}>
                    <Pie
                      data={valueShare}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius="50%"
                      outerRadius="76%"
                      paddingAngle={2}
                      strokeWidth={0}
                      cursor="pointer"
                      onClick={(d: any) => {
                        const name = d?.name
                        const list =
                          name === 'Others'
                            ? byContribution.filter(r => r.contribution > 0).slice(6)
                            : tableRows.filter(r => r.oem_name === name)
                        openList(name, 'Share of pipeline + work-order value', list)
                      }}
                    >
                      {valueShare.map((d, i) => {
                        const dimmed = Boolean(hoveredShare && hoveredShare !== d.name)
                        return (
                          <Cell
                            key={`${d.name}-${i}`}
                            fill={d.fill}
                            fillOpacity={dimmed ? 0.16 : 1}
                            onMouseEnter={() => setHoveredShare(d.name)}
                            style={{ transition: 'opacity 180ms ease' }}
                          />
                        )
                      })}
                    </Pie>
                    <RechartsTooltip content={<ChartTip money />} />
                    <text
                      x="50%"
                      y="47%"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-slate-950 text-[22px] font-bold"
                    >
                      {topContributionPct}%
                    </text>
                    <text
                      x="50%"
                      y="58%"
                      textAnchor="middle"
                      dominantBaseline="middle"
                      className="fill-slate-500 text-[10px] font-semibold"
                    >
                      {topContribution?.name || 'Top OEM'}
                    </text>
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="space-y-1.5 pr-2">
                {valueShare.map((item, index) => {
                  const share = pct(item.value, (totalPipeline + totalWoValue) || 1)
                  const dimmed = Boolean(hoveredShare && hoveredShare !== item.name)
                  return (
                    <button
                      key={item.name}
                      type="button"
                      onMouseEnter={() => setHoveredShare(item.name)}
                      onMouseLeave={() => setHoveredShare(null)}
                      onClick={() => {
                        const list =
                          item.name === 'Others'
                            ? byContribution.filter(r => r.contribution > 0).slice(6)
                            : tableRows.filter(r => r.oem_name === item.name)
                        openList(item.name, 'Share of pipeline + work-order value', list)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition hover:bg-slate-50"
                      style={{ opacity: dimmed ? 0.22 : 1 }}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: item.fill }}
                      />
                      <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-slate-700">
                        {item.name}
                      </span>
                      <span className="text-[10.5px] font-bold tabular-nums text-slate-800">
                        {share}%
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="flex h-[250px] items-center justify-center text-xs text-slate-400">
              No OEM-linked value in this period
            </div>
          )}
        </DashboardCard>

        <DashboardCard
          title="Funnel Presence by OEM"
          sub="Appearances across leads, tenders, quotations and work orders"
          className="min-h-[330px]"
        >
          <div className="h-[278px] px-2 pb-3 pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={funnelPresence}
                layout="vertical"
                margin={{ top: 8, right: 20, left: 2, bottom: 0 }}
                barCategoryGap={8}
                onMouseLeave={() => setHoveredFunnel(null)}
              >
                <CartesianGrid stroke="#e8edf5" strokeDasharray="3 4" horizontal={false} />
                <XAxis
                  type="number"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: C.ink4 }}
                  allowDecimals={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={82}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 10, fill: C.ink3 }}
                />
                <RechartsTooltip content={<ChartTip />} />
                <Legend
                  iconType="square"
                  iconSize={7}
                  verticalAlign="top"
                  align="right"
                  wrapperStyle={{ fontSize: 9, paddingBottom: 8 }}
                />
                {funnelBars.map(bar => (
                  <Bar
                    key={bar.dataKey}
                    dataKey={bar.dataKey}
                    name={bar.name}
                    stackId="funnel"
                    fill={bar.color}
                    radius={0}
                    cursor="pointer"
                    onMouseEnter={(_: any, index: number) =>
                      setHoveredFunnel({ rowIndex: index, dataKey: bar.dataKey })
                    }
                    onClick={(_: any, index: number) => {
                      const row = funnelPresence[index]
                      if (!row) return
                      openList(
                        row.name,
                        'Appearances across leads, tenders, quotations and work orders',
                        tableRows.filter(r => r.oem_name === row.name),
                      )
                    }}
                  >
                    {funnelPresence.map((_, rowIndex) => {
                      const focused =
                        hoveredFunnel?.rowIndex === rowIndex &&
                        hoveredFunnel?.dataKey === bar.dataKey
                      const dimmed = Boolean(hoveredFunnel && !focused)
                      return (
                        <Cell
                          key={`${bar.dataKey}-${rowIndex}`}
                          fill={bar.color}
                          fillOpacity={dimmed ? 0.16 : 1}
                          style={{ transition: 'opacity 180ms ease' }}
                        />
                      )
                    })}
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </DashboardCard>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.9fr_1.08fr_1fr]">
        <DashboardCard
          title="Tender Win-Rate Leaderboard"
          sub="OEMs with at least one decided tender"
          footer={
            <ActionFooter
              label="View detailed leaderboard"
              onClick={() =>
                openList(
                  'Tender Win-Rate Leaderboard',
                  'OEMs ranked by tender win rate',
                  tableRows.filter(
                    r => num(r.tender_won_count) + num(r.tender_lost_count) > 0,
                  ),
                )
              }
            />
          }
        >
          <div className="min-h-[222px] space-y-1.5 px-4 pb-1 pt-1">
            {winRateBoard.length ? (
              winRateBoard.map((r, i) => {
                const dimmed = Boolean(hoveredWin && hoveredWin !== r.name)
                return (
                  <button
                    key={r.name}
                    type="button"
                    onMouseEnter={() => setHoveredWin(r.name)}
                    onMouseLeave={() => setHoveredWin(null)}
                    onClick={() =>
                      openList(
                        r.name,
                        `${fmtN(r.won)} won of ${fmtN(r.decided)} decided tenders`,
                        tableRows.filter(row => row.oem_name === r.name),
                      )
                    }
                    className="grid w-full grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-1 py-1.5 text-left transition hover:bg-slate-50"
                    style={{ opacity: dimmed ? 0.22 : 1 }}
                  >
                    <span className="text-[10px] font-bold tabular-nums text-slate-400">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0">
                      <span className="mb-1.5 block truncate text-[10.5px] font-semibold text-slate-800">
                        {r.name}
                      </span>
                      <span className="block h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <span
                          className="block h-full rounded-full transition-all duration-300"
                          style={{
                            width: `${Math.max(2, r.rate)}%`,
                            backgroundColor: CHART[i % CHART.length],
                          }}
                        />
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-right">
                      <span className="text-[11px] font-bold tabular-nums text-slate-900">
                        {r.rate}%
                      </span>
                      <span className="ml-1 text-[9.5px] text-slate-400">
                        ({fmtN(r.won)} / {fmtN(r.decided)})
                      </span>
                    </span>
                  </button>
                )
              })
            ) : (
              <div className="flex min-h-[210px] items-center justify-center text-xs text-slate-400">
                No decided tenders in this period
              </div>
            )}
          </div>
        </DashboardCard>

        <DashboardCard
          title="Engagement Matrix"
          sub="Activity intensity per OEM across the funnel"
          footer={
            <ActionFooter
              label="View full matrix"
              onClick={() =>
                openList(
                  'Engagement Matrix',
                  'OEM activity intensity across the complete funnel',
                  tableRows,
                )
              }
            />
          }
        >
          <div className="min-h-[222px] overflow-x-auto px-4 pb-1 pt-2">
            <div className="grid min-w-[520px] grid-cols-[82px_repeat(5,minmax(62px,1fr))] gap-1">
              <div />
              {ENGAGE_COLS.map(col => (
                <div
                  key={col}
                  className="truncate px-1 pb-1 text-center text-[8.5px] font-bold uppercase tracking-wide text-slate-400"
                  title={col}
                >
                  {col}
                </div>
              ))}

              {heatmapOems.map(oem => (
                <div key={oem} className="contents">
                  <button
                    type="button"
                    onClick={() =>
                      openList(
                        oem,
                        'Activity intensity across leads, opportunities, tenders, quotations and work orders',
                        tableRows.filter(r => r.oem_name === oem),
                      )
                    }
                    className="truncate pr-2 text-left text-[10px] font-medium text-slate-600 hover:text-indigo-600"
                    title={oem}
                  >
                    {oem}
                  </button>

                  {ENGAGE_COLS.map(col => {
                    const value = heatmapCell(oem, col)
                    const focused = hoveredHeat?.row === oem && hoveredHeat?.col === col
                    const dimmed = Boolean(hoveredHeat && !focused)
                    return (
                      <button
                        key={`${oem}-${col}`}
                        type="button"
                        onMouseEnter={() => setHoveredHeat({ row: oem, col })}
                        onMouseLeave={() => setHoveredHeat(null)}
                        onClick={() =>
                          openList(
                            `${oem} · ${col}`,
                            `${fmtN(value)} ${col.toLowerCase()} linked to this OEM`,
                            tableRows.filter(r => r.oem_name === oem),
                          )
                        }
                        className="relative flex h-[31px] items-center justify-center rounded-md text-[10px] font-bold tabular-nums transition duration-150"
                        style={getHeatCellStyle(value, focused, dimmed)}
                        title={`${oem} · ${col}: ${fmtN(value)}`}
                      >
                        {fmtN(value)}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </DashboardCard>

        <DashboardCard title="Portfolio Snapshot" sub="Concentration, conversion gaps and dormant OEMs">
          <div className="min-h-[278px] space-y-2.5 px-4 pb-4 pt-2">
            {insights.map((it, i) => {
              const isDependency = it.title === 'Dependency concentration'
              const isPending = it.title === 'Quotes pending, no orders'
              const tone = isDependency
                ? {
                    border: 'border-indigo-200',
                    accent: 'bg-indigo-600',
                    icon: 'text-indigo-600 bg-indigo-50',
                  }
                : isPending
                  ? {
                      border: 'border-orange-200',
                      accent: 'bg-orange-500',
                      icon: 'text-orange-600 bg-orange-50',
                    }
                  : {
                      border: 'border-emerald-200',
                      accent: 'bg-emerald-500',
                      icon: 'text-emerald-600 bg-emerald-50',
                    }

              const onClick = isDependency
                ? () =>
                    byContribution[0] &&
                    openList(
                      byContribution[0].oem_name,
                      'Share of pipeline + work-order value',
                      tableRows.filter(r => r.oem_name === byContribution[0].oem_name),
                    )
                : isPending
                  ? () =>
                      openList(
                        'Quotes Pending, No Orders',
                        'OEMs with pending quotations but no work orders yet',
                        stalledRows,
                      )
                  : () =>
                      openList(
                        'Dormant OEMs',
                        'Master OEMs with no lead or tender presence in this period',
                        dormantRows,
                      )

              return (
                <button
                  key={`${it.title}-${i}`}
                  type="button"
                  onClick={onClick}
                  className={`group relative flex w-full items-center gap-3 overflow-hidden rounded-xl border bg-white p-3 text-left transition hover:-translate-y-0.5 hover:shadow-md ${tone.border}`}
                >
                  <span className={`absolute inset-y-0 left-0 w-1 ${tone.accent}`} />
                  <span className={`ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.icon}`}>
                    {isDependency ? '◎' : isPending ? '▤' : '↗'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10.5px] font-bold text-slate-800">
                      {it.title}
                    </span>
                    <span className="mt-0.5 block text-[9.5px] leading-4 text-slate-500">
                      {it.detail}
                    </span>
                  </span>
                  <span className="shrink-0 text-[17px] font-bold tabular-nums text-slate-900">
                    {it.value}
                  </span>
                </button>
              )
            })}
          </div>
        </DashboardCard>
      </div>

      <Section idx="02" title="OEM Register" desc="Complete OEM performance list" />
      <DataTable
        data={tableRows}
        columns={cols as any}
        title="oem-partners"
        showExport
        showColumnToggle
      />

      <ListDrilldownModal request={listDrill} onClose={() => setListDrill(null)} />
    </div>
  )
}