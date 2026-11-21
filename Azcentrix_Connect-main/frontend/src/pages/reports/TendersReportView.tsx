// TENDER ANALYTICS REDESIGN V3 - full-width Tender Distribution Intelligence row
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  DollarSign,
  FileText,
  MapPin,
  RefreshCw,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { reportsApi } from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { DataTable, StatusBadge, type Column } from '@/components/ui/DataTable'
import { useToast } from '@/components/ui/FormComponents'
import { type DrilldownRequest } from './shared/DrilldownDrawer'
import { RecordViewPanel } from '../report-engine/RecordViewPanel'
import {
  ListDrilldownModal,
  type ListDrilldownRequest,
} from './shared/ListDrilldownModal'
import { ReportDateRangeCtx } from './reportToolbarContext'

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

const fmtCur = (value: unknown) => {
  const number = Number(value)
  if (value == null || value === '' || Number.isNaN(number)) return '—'
  if (number >= 1e7) return `Rs ${(number / 1e7).toFixed(2)}Cr`
  if (number >= 1e5) return `Rs ${(number / 1e5).toFixed(2)}L`
  return `Rs ${number.toLocaleString('en-IN')}`
}

const fmtNum = (value: unknown) => {
  const number = Number(value)
  return Number.isNaN(number) ? '—' : number.toLocaleString('en-IN')
}

const fmtPct = (value: unknown) => {
  const number = Number(value)
  return Number.isNaN(number) ? '—' : `${number.toFixed(1)}%`
}

const fmtCr = (value: number) => `Rs ${value.toFixed(value >= 100 ? 0 : 1)} Cr`

const COLORS = [
  '#2563EB',
  '#10B981',
  '#8B5CF6',
  '#F59E0B',
  '#06B6D4',
  '#EF4444',
  '#EC4899',
  '#94A3B8',
]

const RESULT_COLORS: Record<string, string> = {
  Won: '#10B981',
  Lost: '#EF4444',
  Pending: '#F59E0B',
  Cancelled: '#94A3B8',
}

const STAGE_COLORS = ['#2563EB', '#10B981', '#8B5CF6', '#F59E0B', '#F43F5E', '#94A3B8']

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type DistributionTab = 'Unit & Vertical' | 'Source & Segment'

type DistributionRow = {
  name: string
  value: number
  count: number
  won: number
  decided: number
  conversion: number
  color: string
  rows: any[]
}

interface FilterOpts {
  users: { id: number; name: string }[]
  customers: { id: number; name: string }[]
  statuses: string[]
  results: string[]
  portals: string[]
  tech_bid_options: string[]
}

interface TFilters {
  preset: string
  date_from: string
  date_to: string
  submission_from: string
  submission_to: string
  status: string
  result: string
  source_portal: string
  tech_bid_eligible: string
  assigned_to: string
  customer_id: string
  product_name: string
  oem_name: string
  bid_min: string
  bid_max: string
  emd_required: string
  reverse_auction: string
}

const EMPTY: TFilters = {
  preset: 'all',
  date_from: '',
  date_to: '',
  submission_from: '',
  submission_to: '',
  status: '',
  result: '',
  source_portal: '',
  tech_bid_eligible: '',
  assigned_to: '',
  customer_id: '',
  product_name: '',
  oem_name: '',
  bid_min: '',
  bid_max: '',
  emd_required: '',
  reverse_auction: '',
}

const PRESETS = [
  { value: 'all', label: 'All Time' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_quarter', label: 'This Quarter' },
  { value: 'last_quarter', label: 'Last Quarter' },
  { value: 'this_year', label: 'This Year' },
  { value: 'custom', label: 'Custom Range' },
]

// -----------------------------------------------------------------------------
// Reusable UI
// -----------------------------------------------------------------------------

function TrendBadge({ value }: { value: number | null | undefined }) {
  if (value == null) return null
  const isPositive = value >= 0

  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
        isPositive ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
      }`}
    >
      {isPositive ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
      {Math.abs(value).toFixed(1)}%
    </span>
  )
}

function KpiCard({
  label,
  value,
  trend,
  icon,
  borderClass,
  sub,
}: {
  label: string
  value: string
  trend?: number | null
  icon: ReactNode
  borderClass: string
  sub?: string
}) {
  return (
    <div className={`rounded-xl border bg-white p-4 ${borderClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] font-bold uppercase tracking-[0.08em] text-slate-500">
            {label}
          </p>
          <p className="mt-1 text-[22px] font-black leading-none text-slate-950">{value}</p>
          {sub && <p className="mt-1.5 truncate text-[10px] text-slate-400">{sub}</p>}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-slate-50">{icon}</div>
          <TrendBadge value={trend} />
        </div>
      </div>
    </div>
  )
}

function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-3 flex min-h-[34px] items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-600">
          {title}
        </h3>
        {subtitle && <p className="mt-0.5 text-[9px] text-slate-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

function DrilldownPill() {
  return (
    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[8px] font-extrabold text-slate-500">
      Drilldown
    </span>
  )
}

const ChartTip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs shadow-xl">
      {label != null && <p className="mb-1 font-semibold text-slate-800">{label}</p>}
      {payload.map((item: any) => (
        <p key={`${item.dataKey}-${item.name}`} style={{ color: item.color }} className="font-medium">
          {item.name || item.dataKey}: {item.dataKey === 'value' || item.dataKey === 'bidValue' ? fmtCur(item.value) : item.value}
          {item.dataKey === 'share' || item.dataKey === 'winRate' ? '%' : ''}
        </p>
      ))}
    </div>
  )
}

function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { id: string | number; name: string }[]
  value: string
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = value ? value.split(',').filter(Boolean) : []

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(Array.from(next).join(','))
  }

  return (
    <div className="relative">
      <label className="mb-1 block text-[11px] font-semibold text-slate-600">{label}</label>
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        className="flex h-9 w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 text-left text-[12px] text-slate-800 outline-none transition hover:border-blue-300 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
      >
        <span className={selected.length ? 'text-slate-900' : 'text-slate-400'}>
          {selected.length === 0
            ? 'All'
            : selected.length === 1
              ? options.find(option => String(option.id) === selected[0])?.name || selected[0]
              : `${selected.length} selected`}
        </span>
        <ChevronDown size={13} className="shrink-0 text-slate-400" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-56 w-full min-w-[190px] overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-2xl">
          {options.map(option => {
            const id = String(option.id)
            const checked = selected.includes(id)

            return (
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-blue-50 ${
                  checked ? 'bg-blue-50 text-blue-800' : 'text-slate-700'
                }`}
              >
                <span
                  className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded border ${
                    checked ? 'border-blue-600 bg-blue-600' : 'border-slate-300'
                  }`}
                >
                  {checked && (
                    <svg viewBox="0 0 10 8" className="h-2.5 w-2.5 fill-white">
                      <path d="M1 4l3 3 5-6" />
                    </svg>
                  )}
                </span>
                {option.name}
              </button>
            )
          })}

          {selected.length > 0 && (
            <div className="border-t border-slate-100 p-2">
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="w-full text-center text-xs text-slate-500 hover:text-red-500"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

function buildDistributionRowsFromData(
  rows: any[],
  getName: (row: any) => string,
): DistributionRow[] {
  const groups: Record<string, any[]> = {}

  rows.forEach(row => {
    const key = getName(row) || 'Unclassified'
    if (!groups[key]) groups[key] = []
    groups[key].push(row)
  })

  return Object.entries(groups)
    .map(([name, group]) => {
      const won = group.filter(row => String(row.result || '') === 'Won').length
      const decided = group.filter(row =>
        ['Won', 'Lost', 'Cancelled'].includes(String(row.result || '')),
      ).length
      const rawValue = group.reduce(
        (sum, row) => sum + Number(row.est_value || row.bid_amount || row.product_value || 0),
        0,
      )

      return {
        name,
        value: Math.round((rawValue / 1e7) * 10) / 10,
        count: group.length,
        won,
        decided,
        conversion: decided ? (won / decided) * 100 : 0,
        color: COLORS[0],
        rows: group,
      }
    })
    .sort((a, b) => b.value - a.value || b.count - a.count)
    .slice(0, 6)
    .map((row, index) => ({ ...row, color: COLORS[index % COLORS.length] }))
}

function buildDistributionRowsFromAnalytics(
  items: any[],
  labelKeys: string[],
  allRows: any[],
  rowName: (row: any) => string,
): DistributionRow[] {
  if (!Array.isArray(items) || !items.length) {
    return buildDistributionRowsFromData(allRows, rowName)
  }

  return items
    .slice(0, 6)
    .map((item, index) => {
      const name =
        labelKeys.map(key => item?.[key]).find(value => value != null && value !== '') ||
        item?.name ||
        item?.label ||
        'Unclassified'
      const normalizedName = String(name)
      const won = Number(item.won || 0)
      const lost = Number(item.lost || 0)
      const cancelled = Number(item.cancelled || 0)
      const decided = won + lost + cancelled
      const rawValue = Number(
        item.total_bid_value ||
          item.bid_value ||
          item.est_value ||
          item.product_value ||
          item.value ||
          0,
      )
      const value = rawValue > 1e5 ? rawValue / 1e7 : rawValue

      return {
        name: normalizedName,
        value: Math.round(value * 10) / 10,
        count: Number(item.tenders || item.tender_count || item.count || item.total || 0),
        won,
        decided,
        conversion: Number(
          item.win_rate ?? item.success_rate ?? (decided ? (won / decided) * 100 : 0),
        ),
        color: COLORS[index % COLORS.length],
        rows: allRows.filter(row => rowName(row) === normalizedName),
      }
    })
    .sort((a, b) => b.value - a.value || b.count - a.count)
}

function aggregateByName(
  rows: any[],
  getName: (row: any) => string,
  getValue: (row: any) => number,
) {
  const grouped = new Map<string, { name: string; value: number; count: number; rows: any[] }>()

  rows.forEach(row => {
    const name = getName(row) || 'Unassigned'
    const current = grouped.get(name) || { name, value: 0, count: 0, rows: [] }
    current.value += getValue(row)
    current.count += 1
    current.rows.push(row)
    grouped.set(name, current)
  })

  return Array.from(grouped.values()).sort((a, b) => b.value - a.value || b.count - a.count)
}

function buildDailyComparison(dataRows: any[], chartDaily: any[]) {
  const grouped = new Map<
    string,
    { label: string; Submitted: number; Won: number; Lost: number; Pending: number }
  >()

  dataRows.forEach(row => {
    const rawDate = row.submission_date || row.created_at || row.tender_date
    if (!rawDate) return
    const key = String(rawDate).slice(0, 10)
    const date = new Date(key)
    const label = Number.isNaN(date.getTime())
      ? key
      : date.toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
    const current = grouped.get(key) || {
      label,
      Submitted: 0,
      Won: 0,
      Lost: 0,
      Pending: 0,
    }

    current.Submitted += 1
    const result = String(row.result || 'Pending')
    if (result === 'Won') current.Won += 1
    else if (result === 'Lost') current.Lost += 1
    else current.Pending += 1
    grouped.set(key, current)
  })

  const fromRows = Array.from(grouped.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)
    .map(([, value]) => value)

  if (fromRows.length > 1) return fromRows

  return (chartDaily || []).map((row: any) => ({
    label: row.label,
    Submitted: Number(row.count || row.submitted || 0),
    Won: Number(row.won || 0),
    Lost: Number(row.lost || 0),
    Pending: Number(row.pending || 0),
  }))
}

// -----------------------------------------------------------------------------
// Product comparison cards
// -----------------------------------------------------------------------------

function ProductPerformancePanel({
  rows,
  onOpen,
}: {
  rows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const { labelLower: tenderLabelLower } = useModuleName('tenders')
  const [hovered, setHovered] = useState<string | null>(null)
  const top = rows.slice(0, 6)

  if (!top.length) {
    return (
      <div className="grid h-[310px] place-items-center text-xs text-slate-400">
        No product performance data available
      </div>
    )
  }

  const segments: {
    key: 'won' | 'lost' | 'pending' | 'cancelled'
    label: string
    color: string
  }[] = [
    { key: 'won', label: 'Won', color: RESULT_COLORS.Won },
    { key: 'lost', label: 'Lost', color: RESULT_COLORS.Lost },
    { key: 'pending', label: 'Pending', color: RESULT_COLORS.Pending },
    { key: 'cancelled', label: 'Cancelled', color: RESULT_COLORS.Cancelled },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {segments.map(segment => (
          <span
            key={segment.key}
            className="inline-flex items-center gap-1.5 text-[9px] font-bold text-slate-500"
          >
            <i className="h-2 w-2 rounded-full" style={{ backgroundColor: segment.color }} />
            {segment.label}
          </span>
        ))}
      </div>

      <div className="space-y-2.5">
        {top.map(row => {
          const key = row.product_id != null ? `pid:${row.product_id}` : `name:${row.product_name}`
          const total =
            Number(row.won || 0) +
            Number(row.lost || 0) +
            Number(row.pending || 0) +
            Number(row.cancelled || 0)
          const dimmed = hovered != null && hovered !== key

          return (
            <div
              key={key}
              onMouseEnter={() => setHovered(key)}
              onMouseLeave={() => setHovered(null)}
              className={`rounded-[10px] border border-slate-100 bg-white px-3 py-2.5 transition ${
                dimmed ? 'opacity-35' : 'opacity-100'
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="truncate text-[11px] font-bold text-slate-900">{row.product_name}</span>
                <span className="shrink-0 text-[10px] font-black text-slate-950">
                  {fmtPct(row.win_rate)} win
                </span>
              </div>

              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                {segments.map((segment, index) => {
                  const value = Number(row[segment.key] || 0)
                  if (!value || !total) return null
                  const width = (value / total) * 100

                  return (
                    <button
                      key={segment.key}
                      type="button"
                      title={`${segment.label}: ${value}`}
                      onClick={() =>
                        onOpen(
                          `${row.product_name} — ${segment.label}`,
                          'Product performance drilldown',
                          (row.rows || []).filter((item: any) => item.result === segment.label),
                        )
                      }
                      className="h-full transition hover:brightness-95"
                      style={{
                        width: `${width}%`,
                        backgroundColor: segment.color,
                        borderRight: index < segments.length - 1 ? '1px solid white' : undefined,
                      }}
                    />
                  )
                })}
              </div>

              <p className="mt-1 text-[9px] text-slate-400">
                {fmtNum(total)} {tenderLabelLower} · {Number(row.won || 0)} won · {Number(row.lost || 0)} lost ·{' '}
                {Number(row.pending || 0)} pending
              </p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ProductDemandPanel({
  rows,
  onOpen,
}: {
  rows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const { labelLower: tenderLabelLower } = useModuleName('tenders')
  const top = rows.slice(0, 6)
  const maxValue = Math.max(...top.map(row => Number(row.product_value || 0)), 1)

  if (!top.length) {
    return (
      <div className="grid h-[310px] place-items-center text-xs text-slate-400">
        No product demand data available
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {top.map((row, index) => {
        const value = Number(row.product_value || 0)
        const width = (value / maxValue) * 100

        return (
          <button
            key={row.product_id != null ? `pid:${row.product_id}` : `name:${row.product_name}`}
            type="button"
            onClick={() => onOpen(row.product_name, 'Product demand drilldown', row.rows || [])}
            className="group w-full rounded-[10px] border border-slate-100 bg-white px-3 py-2.5 text-left transition hover:border-blue-200 hover:shadow-sm"
          >
            <div className="mb-2 flex items-center gap-2.5">
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[9px] font-black ${
                  index < 3 ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {String(index + 1).padStart(2, '0')}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-bold text-slate-900">{row.product_name}</p>
                <p className="mt-0.5 text-[9px] text-slate-400">
                  {fmtNum(row.tender_count)} {tenderLabelLower} · {fmtNum(row.total_quantity)} units
                </p>
              </div>

              <div className="text-right">
                <p className="text-[11px] font-black text-slate-950">{fmtCur(value)}</p>
                <p className="text-[8px] text-slate-400">BOQ value</p>
              </div>
            </div>

            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-500"
                style={{ width: `${width}%` }}
              />
            </div>
          </button>
        )
      })}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Compact tender distribution card
// -----------------------------------------------------------------------------

function DistributionRankedBars({
  title,
  rows,
  onOpen,
}: {
  title: string
  rows: DistributionRow[]
  onOpen: (row: DistributionRow) => void
}) {
  const { labelLower: tenderLabelLower } = useModuleName('tenders')
  const top = rows.slice(0, 5)
  const maxValue = Math.max(...top.map(row => Number(row.value || 0)), 1)
  const total = top.reduce((sum, row) => sum + Number(row.value || 0), 0)

  if (!top.length) {
    return <div className="grid min-h-[390px] place-items-center text-sm text-slate-400">No data available</div>
  }

  return (
    <div className="min-w-0">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-[11px] font-extrabold text-slate-600">{title}</p>
        <span className="text-[11px] font-black text-slate-950">{fmtCr(total)}</span>
      </div>

      <div className="space-y-3">
        {top.map((row, index) => {
          const width = Math.max(2, (Number(row.value || 0) / maxValue) * 100)
          const share = total ? (Number(row.value || 0) / total) * 100 : 0

          return (
            <button
              key={row.name}
              type="button"
              onClick={() => onOpen(row)}
              className="group w-full rounded-xl border border-slate-100 bg-slate-50/55 px-3 py-3 text-left transition hover:border-blue-200 hover:bg-white hover:shadow-sm"
            >
              <div className="mb-2 flex items-center gap-2.5">
                <span
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[10px] font-black ${
                    index < 3 ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-200'
                  }`}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-800">
                  {row.name}
                </span>
                <span className="shrink-0 text-[11px] font-black text-slate-950">
                  {fmtCr(row.value)}
                </span>
              </div>

              <div className="h-2 overflow-hidden rounded-full bg-slate-200/70">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${width}%`, backgroundColor: row.color || COLORS[index % COLORS.length] }}
                />
              </div>

              <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
                <span>{fmtNum(row.count)} {tenderLabelLower}</span>
                <span>{share.toFixed(1)}% share</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DistributionLollipopMini({
  title,
  rows,
  onOpen,
}: {
  title: string
  rows: DistributionRow[]
  onOpen: (row: DistributionRow) => void
}) {
  const { labelLower: tenderLabelLower } = useModuleName('tenders')
  const top = rows.slice(0, 5)
  const maxValue = Math.max(...top.map(row => Number(row.value || 0)), 1)
  const total = top.reduce((sum, row) => sum + Number(row.value || 0), 0)

  if (!top.length) {
    return <div className="grid min-h-[390px] place-items-center text-sm text-slate-400">No data available</div>
  }

  return (
    <div className="flex min-h-[390px] min-w-0 flex-col">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-[11px] font-extrabold text-slate-600">{title}</p>
        <span className="text-[11px] font-black text-slate-950">{fmtCr(total)}</span>
      </div>

      <div className="flex flex-1 flex-col justify-between rounded-xl border border-slate-100 bg-slate-50/45 p-4">
        {top.map((row, index) => {
          const width = Math.max(5, (Number(row.value || 0) / maxValue) * 100)
          const share = total ? (Number(row.value || 0) / total) * 100 : 0

          return (
            <button
              key={row.name}
              type="button"
              onClick={() => onOpen(row)}
              className="group grid min-h-[54px] w-full grid-cols-[140px_minmax(0,1fr)_92px] items-center gap-3 text-left"
            >
              <span className="min-w-0 text-right">
                <span className="block truncate text-[10px] font-bold text-slate-600 group-hover:text-slate-950">
                  {row.name}
                </span>
                <span className="mt-0.5 block text-[9px] text-slate-400">
                  {fmtNum(row.count)} tenders
                </span>
              </span>

              <span className="relative h-[3px] rounded-full bg-slate-200">
                <span
                  className="absolute left-0 top-0 h-[3px] rounded-full transition-all duration-500"
                  style={{ width: `${width}%`, backgroundColor: row.color || COLORS[index % COLORS.length] }}
                >
                  <span
                    className="absolute -right-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-[3px] border-white shadow ring-1 ring-slate-200 transition group-hover:scale-110"
                    style={{ backgroundColor: row.color || COLORS[index % COLORS.length] }}
                  />
                </span>
              </span>

              <span className="text-right">
                <span className="block text-[10px] font-black text-slate-950">{fmtCr(row.value)}</span>
                <span className="mt-0.5 block text-[9px] text-slate-400">{share.toFixed(1)}% share</span>
              </span>
            </button>
          )
        })}

        <div className="mt-3 flex items-center justify-between rounded-lg border border-slate-100 bg-white px-3 py-2.5 text-[10px] text-slate-500">
          <span>Lollipop endpoint represents bid value</span>
          <span className="font-bold text-slate-700">Top {top.length}</span>
        </div>
      </div>
    </div>
  )
}

function TenderDistributionComparison({
  analytics,
  dataRows,
  activeTab,
  onTabChange,
  onOpenRows,
}: {
  analytics: any
  dataRows: any[]
  activeTab: DistributionTab
  onTabChange: (tab: DistributionTab) => void
  onOpenRows: (title: string, sub: string, rows: any[]) => void
}) {
  const businessUnitRows = buildDistributionRowsFromAnalytics(
    analytics?.business_units || [],
    ['business_unit', 'unit', 'name'],
    dataRows,
    row => String(row.business_unit_name || row.business_unit || row.business_vertical || 'Unclassified'),
  )

  const businessVerticalRows = buildDistributionRowsFromAnalytics(
    analytics?.business_verticals || [],
    ['business_vertical', 'vertical', 'name'],
    dataRows,
    row =>
      String(
        row.business_vertical_name ||
          row.business_vertical_group ||
          row.business_vertical ||
          'Unclassified',
      ),
  )

  const sourceRows = buildDistributionRowsFromAnalytics(
    analytics?.portal_roi || [],
    ['portal', 'source_portal', 'name'],
    dataRows,
    row => String(row.source_portal || row.portal || 'Other'),
  )

  const segmentRows = buildDistributionRowsFromAnalytics(
    analytics?.customer_segments || [],
    ['segment', 'customer_segment', 'name'],
    dataRows,
    row => String(row.customer_segment || row.segment || 'Unclassified'),
  )

  const leftRows = activeTab === 'Unit & Vertical' ? businessUnitRows : sourceRows
  const rightRows = activeTab === 'Unit & Vertical' ? businessVerticalRows : segmentRows
  const leftTitle = activeTab === 'Unit & Vertical' ? 'By Business Unit (Bid Value)' : 'By Source (Bid Value)'
  const rightTitle = activeTab === 'Unit & Vertical' ? 'By Vertical (Bid Value)' : 'By Customer Segment (Bid Value)'
  const leftSub = activeTab === 'Unit & Vertical' ? 'Business Unit' : 'Source'
  const rightSub = activeTab === 'Unit & Vertical' ? 'Business Vertical' : 'Customer Segment'

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-[14px] font-extrabold uppercase tracking-[0.045em] text-slate-700">
            Tender Distribution Intelligence
          </h3>
          <p className="mt-1 text-[11px] text-slate-400">
            Business unit, vertical, source and customer segment comparison
          </p>
        </div>
        <DrilldownPill />
      </div>

      <div className="mb-5 flex gap-8 border-b border-slate-100">
        {(['Unit & Vertical', 'Source & Segment'] as DistributionTab[]).map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => onTabChange(tab)}
            className={`relative pb-3 text-[12px] font-extrabold transition ${
              activeTab === tab ? 'text-blue-700' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {tab}
            {activeTab === tab && (
              <span className="absolute inset-x-0 bottom-0 h-[3px] rounded-full bg-blue-600" />
            )}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 items-stretch gap-6 xl:grid-cols-2">
        <DistributionRankedBars
          title={leftTitle}
          rows={leftRows}
          onOpen={row => onOpenRows(row.name, `${leftSub} tender drilldown`, row.rows || [])}
        />
        <DistributionLollipopMini
          title={rightTitle}
          rows={rightRows}
          onOpen={row => onOpenRows(row.name, `${rightSub} tender drilldown`, row.rows || [])}
        />
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Four-card comparison row
// -----------------------------------------------------------------------------

function TenderOutcomeCard({
  summary,
  chartStage,
  chartRes,
  dataRows,
  onOpen,
}: {
  summary: any
  chartStage: any[]
  chartRes: any[]
  dataRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const resultMap = Object.fromEntries(
    (chartRes || []).map((item: any) => [String(item.label), Number(item.count || 0)]),
  )
  const stageMap = Object.fromEntries(
    (chartStage || []).map((item: any) => [String(item.stage), Number(item.count || 0)]),
  )

  const items = [
    {
      label: 'Total Tenders',
      value: Number(summary.total || dataRows.length || 0),
      color: '#2563EB',
      rows: dataRows,
    },
    {
      label: 'Submitted',
      value: Number(stageMap.Submitted || 0),
      color: '#8B5CF6',
      rows: dataRows.filter(row => String(row.tender_status || row.status || '') === 'Submitted'),
    },
    {
      label: 'Won',
      value: Number(summary.won || resultMap.Won || 0),
      color: '#10B981',
      rows: dataRows.filter(row => String(row.result || '') === 'Won'),
    },
    {
      label: 'Lost',
      value: Number(resultMap.Lost || 0),
      color: '#F59E0B',
      rows: dataRows.filter(row => String(row.result || '') === 'Lost'),
    },
    {
      label: 'Cancelled',
      value: Number(resultMap.Cancelled || 0),
      color: '#94A3B8',
      rows: dataRows.filter(row => String(row.result || '') === 'Cancelled'),
    },
  ]

  const total = Math.max(items[0].value, 1)
  const widths = [100, 82, 64, 47, 30]

  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
      <CardHeader title="Tender Outcome" subtitle="By result" action={<DrilldownPill />} />

      <div className="mt-2 flex flex-col items-center gap-1.5">
        {items.map((item, index) => (
          <button
            key={item.label}
            type="button"
            onClick={() => onOpen(item.label, 'Tender outcome drilldown', item.rows)}
            className="group relative flex h-9 items-center justify-center text-white transition hover:brightness-95"
            style={{
              width: `${widths[index]}%`,
              backgroundColor: item.color,
              clipPath: 'polygon(6% 0, 94% 0, 100% 100%, 0 100%)',
            }}
          >
            <span className="text-[9px] font-semibold">{item.label}</span>
            <span className="ml-2 text-[11px] font-black">{fmtNum(item.value)}</span>
            <span className="absolute right-2 text-[8px] font-bold opacity-95">
              {`${((item.value / total) * 100).toFixed(1)}%`}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function ResultAnalysisCard({
  chartRes,
  dataRows,
  onOpen,
}: {
  chartRes: any[]
  dataRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const rows = (chartRes || [])
    .map((item: any) => ({
      label: String(item.label || 'Pending'),
      count: Number(item.count || 0),
    }))
    .sort((a, b) => b.count - a.count)
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  const maxCount = Math.max(...rows.map(row => row.count), 1)

  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
      <CardHeader title="Result Analysis" subtitle="Outcome mix and contribution" action={<DrilldownPill />} />

      {rows.length ? (
        <div>
          <div className="mb-4 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
            <div className="mb-2 flex items-end justify-between gap-3">
              <div>
                <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400">Total outcomes</p>
                <p className="mt-0.5 text-[24px] font-black leading-none text-slate-950">{fmtNum(total)}</p>
              </div>
              <p className="text-right text-[8px] text-slate-400">Click any result<br />for drilldown</p>
            </div>

            <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-slate-200">
              {rows.map(row => {
                const width = total ? (row.count / total) * 100 : 0
                const dimmed = hovered != null && hovered !== row.label
                return (
                  <button
                    key={row.label}
                    type="button"
                    title={`${row.label}: ${row.count}`}
                    onMouseEnter={() => setHovered(row.label)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() =>
                      onOpen(
                        row.label,
                        'Result analysis drilldown',
                        dataRows.filter(item => String(item.result || 'Pending') === row.label),
                      )
                    }
                    className={`h-full transition ${dimmed ? 'opacity-25' : 'opacity-100'}`}
                    style={{
                      width: `${width}%`,
                      backgroundColor: RESULT_COLORS[row.label] || COLORS[0],
                    }}
                  />
                )
              })}
            </div>
          </div>

          <div className="space-y-2.5">
            {rows.slice(0, 5).map(row => {
              const percentage = total ? (row.count / total) * 100 : 0
              const width = (row.count / maxCount) * 100
              const color = RESULT_COLORS[row.label] || COLORS[0]
              const dimmed = hovered != null && hovered !== row.label

              return (
                <button
                  key={row.label}
                  type="button"
                  onMouseEnter={() => setHovered(row.label)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() =>
                    onOpen(
                      row.label,
                      'Result analysis drilldown',
                      dataRows.filter(item => String(item.result || 'Pending') === row.label),
                    )
                  }
                  className={`w-full text-left transition ${dimmed ? 'opacity-30' : 'opacity-100'}`}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <i className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
                    <span className="min-w-0 flex-1 truncate text-[9px] font-bold text-slate-600">{row.label}</span>
                    <span className="text-[9px] font-black text-slate-900">{fmtNum(row.count)}</span>
                    <span className="w-10 text-right text-[8px] font-semibold text-slate-400">{percentage.toFixed(1)}%</span>
                  </div>
                  <div className="ml-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="grid h-[230px] place-items-center text-xs text-slate-400">No result data</div>
      )}
    </div>
  )
}

function PortalPerformanceCard({
  analytics,
  dataRows,
  onOpen,
}: {
  analytics: any
  dataRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const fallback = aggregateByName(
    dataRows,
    row => String(row.source_portal || row.portal || 'Other'),
    row => Number(row.bid_amount || row.est_value || 0),
  )

  const analyticsRows = Array.isArray(analytics?.portal_roi) ? analytics.portal_roi : []
  const rows = (analyticsRows.length
    ? analyticsRows.map((row: any) => {
        const name = String(row.portal || row.source_portal || row.name || 'Other')
        return {
          name,
          value: Number(row.total_bid_value || row.bid_value || row.value || row.est_value || 0),
          rows: dataRows.filter(item => String(item.source_portal || item.portal || 'Other') === name),
        }
      })
    : fallback
  )
    .slice(0, 4)
    .map((row: any) => ({ ...row }))

  const total = Math.max(rows.reduce((sum: number, row: any) => sum + Number(row.value || 0), 0), 1)
  const chartRows = rows.map((row: any, index: number) => ({
    ...row,
    share: Number(((Number(row.value || 0) / total) * 100).toFixed(1)),
    color: COLORS[index % COLORS.length],
  }))

  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
      <CardHeader title="Portal Performance" subtitle="By bid value" action={<DrilldownPill />} />

      {chartRows.length ? (
        <ResponsiveContainer width="100%" height={210}>
          <BarChart data={chartRows} margin={{ top: 16, right: 4, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#64748B' }} axisLine={false} tickLine={false} />
            <YAxis hide domain={[0, 'dataMax + 10']} />
            <Tooltip content={<ChartTip />} />
            <Bar
              dataKey="share"
              name="Share"
              radius={[6, 6, 0, 0]}
              onMouseEnter={(_, index) => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              onClick={(entry: any) =>
                onOpen(entry.name, 'Portal performance drilldown', entry.rows || [])
              }
            >
              {chartRows.map((row: any, index: number) => (
                <Cell
                  key={row.name}
                  fill={row.color}
                  fillOpacity={hoveredIndex == null || hoveredIndex === index ? 1 : 0.24}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="grid h-[210px] place-items-center text-xs text-slate-400">No portal data</div>
      )}
    </div>
  )
}

function TopAssignedUsersCard({
  analytics,
  dataRows,
  onOpen,
}: {
  analytics: any
  dataRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const fallback = aggregateByName(
    dataRows,
    row => String(row.assigned_to || row.owner_name || 'Unassigned'),
    row => Number(row.bid_amount || row.est_value || 0),
  )

  const rawAnalytics =
    analytics?.top_assigned_users || analytics?.assigned_users || analytics?.owner_performance || []

  const rows = (Array.isArray(rawAnalytics) && rawAnalytics.length
    ? rawAnalytics.map((row: any) => {
        const name = String(row.owner || row.user || row.assigned_to || row.name || 'Unassigned')
        return {
          name,
          value: Number(row.total_bid_value || row.bid_value || row.value || row.est_value || 0),
          count: Number(row.tenders || row.count || 0),
          rows: dataRows.filter(item => String(item.assigned_to || item.owner_name || 'Unassigned') === name),
        }
      })
    : fallback
  ).slice(0, 5)

  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
      <CardHeader title="Top Assigned Users" subtitle="By bid value" action={<DrilldownPill />} />

      <div className="mt-2 space-y-2.5">
        {rows.length ? (
          rows.map((row: any, index: number) => {
            const initials = String(row.name || 'U')
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part: string) => part.charAt(0).toUpperCase())
              .join('')

            return (
              <button
                key={`${row.name}-${index}`}
                type="button"
                onClick={() => onOpen(row.name, 'Assigned user drilldown', row.rows || [])}
                className="flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left transition hover:bg-slate-50"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-blue-50 text-[10px] font-black text-blue-700">
                  {initials || <Users size={13} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[10px] font-bold text-slate-800">{row.name}</p>
                  <p className="mt-0.5 text-[8px] text-slate-400">{fmtNum(row.count || row.rows?.length || 0)} tenders</p>
                </div>
                <span className="shrink-0 text-[10px] font-black text-slate-900">{fmtCur(row.value)}</span>
              </button>
            )
          })
        ) : (
          <div className="grid h-[200px] place-items-center text-xs text-slate-400">No owner data</div>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Two-card rows
// -----------------------------------------------------------------------------

function DailyTrendCard({
  rows,
  allRows,
  onOpen,
}: {
  rows: any[]
  allRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen('Daily Trend', 'Tender daily trend drilldown', allRows)}
      className="h-full rounded-xl border border-slate-200 bg-white p-4 text-left"
    >
      <CardHeader title="Daily Trend (Last 30 Days)" subtitle="Submitted · Won · Lost" action={<DrilldownPill />} />

      {rows.length > 1 ? (
        <ResponsiveContainer width="100%" height={205}>
          <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 2, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 8, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 8, fill: '#94A3B8' }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip content={<ChartTip />} />
            <Legend wrapperStyle={{ fontSize: 9, paddingTop: 2 }} iconType="circle" iconSize={7} />
            <Line type="monotone" dataKey="Submitted" stroke="#2563EB" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="Won" stroke="#10B981" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            <Line type="monotone" dataKey="Lost" stroke="#EF4444" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="grid h-[205px] place-items-center text-xs text-slate-400">No daily trend data</div>
      )}
    </button>
  )
}

function PipelineStagesCard({
  chartStage,
  dataRows,
  onOpen,
}: {
  chartStage: any[]
  dataRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const total = Math.max(
    (chartStage || []).reduce((sum, stage) => sum + Number(stage.count || 0), 0),
    1,
  )
  const complete = Number(
    (chartStage || []).find(stage => String(stage.stage) === 'Submitted')?.count || 0,
  )
  const progress = Math.min(100, (complete / total) * 100)

  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
      <CardHeader title="Pipeline Stages" subtitle="By count" action={<DrilldownPill />} />

      <div className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {(chartStage || []).map((stage: any, index: number) => (
          <button
            key={stage.stage}
            type="button"
            onClick={() =>
              onOpen(
                String(stage.stage),
                'Pipeline stage drilldown',
                dataRows.filter(
                  row => String(row.tender_status || row.status || '') === String(stage.stage),
                ),
              )
            }
            className="relative h-[74px] px-3 text-center text-white transition hover:brightness-95"
            style={{
              backgroundColor: STAGE_COLORS[index % STAGE_COLORS.length],
              clipPath:
                index === 0
                  ? 'polygon(0 0, 88% 0, 100% 50%, 88% 100%, 0 100%)'
                  : 'polygon(0 0, 88% 0, 100% 50%, 88% 100%, 0 100%, 12% 50%)',
            }}
          >
            <p className="text-[22px] font-black leading-none">{fmtNum(stage.count)}</p>
            <p className="mt-1.5 truncate text-[8px] font-bold">{stage.stage}</p>
          </button>
        ))}
      </div>

      <div className="mt-8">
        <div className="mb-1.5 flex items-center justify-between text-[8px] font-semibold text-slate-500">
          <span>Overall Progress</span>
          <span>{progress.toFixed(1)}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-blue-600" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  )
}

function TechEligibilityCard({
  chartTech,
  dataRows,
  onOpen,
}: {
  chartTech: any[]
  dataRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const eligible =
    (chartTech || []).find(item => String(item.label).toLowerCase().includes('eligible')) ||
    chartTech?.[0] ||
    { win_rate: 0, won: 0, total: 0, label: 'Eligible' }
  const winRate = Math.max(0, Math.min(100, Number(eligible.win_rate || 0)))
  const chartRows = [
    { name: 'Eligible win rate', value: winRate },
    { name: 'Remaining', value: 100 - winRate },
  ]

  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
      <CardHeader title="Win Rate by Tech Eligibility" subtitle="By count" action={<DrilldownPill />} />

      <div className="grid grid-cols-[minmax(220px,1fr)_minmax(180px,.8fr)] items-center gap-3">
        <button
          type="button"
          onClick={() =>
            onOpen(
              String(eligible.label || 'Eligible'),
              'Tech eligibility drilldown',
              dataRows.filter(row =>
                String(row.tech_bid_eligible || '')
                  .toLowerCase()
                  .includes('eligible'),
              ),
            )
          }
          className="relative h-[205px]"
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartRows}
                dataKey="value"
                cx="50%"
                cy="78%"
                startAngle={180}
                endAngle={0}
                innerRadius={66}
                outerRadius={92}
                paddingAngle={0}
                stroke="none"
              >
                <Cell fill="#10B981" />
                <Cell fill="#E2E8F0" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>

          <div className="pointer-events-none absolute inset-x-0 bottom-[22px] text-center">
            <p className="text-[25px] font-black leading-none text-slate-950">{winRate.toFixed(0)}%</p>
            <p className="mt-1 text-[9px] font-semibold text-slate-500">
              ({fmtNum(eligible.won)}/{fmtNum(eligible.total)})
            </p>
          </div>
        </button>

        <div className="space-y-4">
          {(chartTech || []).slice(0, 3).map((item: any, index: number) => (
            <button
              key={item.label}
              type="button"
              onClick={() =>
                onOpen(
                  String(item.label),
                  'Tech eligibility drilldown',
                  dataRows.filter(row => String(row.tech_bid_eligible || '') === String(item.label)),
                )
              }
              className="flex w-full items-center gap-2 text-left"
            >
              <i
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: index === 0 ? '#10B981' : '#CBD5E1' }}
              />
              <span className="flex-1 text-[9px] font-semibold text-slate-600">{item.label}</span>
              <span className="text-[9px] font-black text-slate-900">
                {fmtNum(item.total)} ({fmtPct(item.win_rate)})
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function GeographicDistributionCard({
  analytics,
  dataRows,
  onOpen,
}: {
  analytics: any
  dataRows: any[]
  onOpen: (title: string, sub: string, rows: any[]) => void
}) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const fallback = aggregateByName(
    dataRows,
    row =>
      String(
        row.state_name ||
          row.customer_state ||
          row.billing_state ||
          row.state ||
          row.district_name ||
          'Unassigned',
      ),
    row => Number(row.bid_amount || row.est_value || 0),
  )

  const rawAnalytics =
    analytics?.geographical_distribution || analytics?.state_distribution || analytics?.states || []

  const rows = (Array.isArray(rawAnalytics) && rawAnalytics.length
    ? rawAnalytics.map((row: any) => {
        const name = String(row.state || row.state_name || row.name || row.label || 'Unassigned')
        return {
          name,
          value: Number(row.total_bid_value || row.bid_value || row.value || row.est_value || 0),
          count: Number(row.tenders || row.count || 0),
          rows: dataRows.filter(item =>
            String(
              item.state_name ||
                item.customer_state ||
                item.billing_state ||
                item.state ||
                item.district_name ||
                'Unassigned',
            ) === name,
          ),
        }
      })
    : fallback
  )
    .sort((a: any, b: any) => Number(b.value || 0) - Number(a.value || 0))
    .slice(0, 6)

  const totalValue = Math.max(
    rows.reduce((sum: number, row: any) => sum + Number(row.value || 0), 0),
    0,
  )
  const maxValue = Math.max(...rows.map((row: any) => Number(row.value || 0)), 1)

  return (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
      <CardHeader
        title="Geographical Distribution"
        subtitle="Location ranking by bid value"
        action={<DrilldownPill />}
      />

      {rows.length ? (
        <div>
          <div className="mb-4 grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-3">
              <p className="text-[8px] font-bold uppercase tracking-wider text-blue-500">Covered locations</p>
              <p className="mt-1 text-[20px] font-black leading-none text-slate-950">{fmtNum(rows.length)}</p>
            </div>
            <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-3">
              <p className="text-[8px] font-bold uppercase tracking-wider text-violet-500">Total bid value</p>
              <p className="mt-1 truncate text-[17px] font-black leading-none text-slate-950">{fmtCur(totalValue)}</p>
            </div>
          </div>

          <div className="space-y-3">
            {rows.map((row: any, index: number) => {
              const width = Math.max(3, (Number(row.value || 0) / maxValue) * 100)
              const share = totalValue ? (Number(row.value || 0) / totalValue) * 100 : 0
              const dimmed = hoveredIndex != null && hoveredIndex !== index
              const color = COLORS[index % COLORS.length]

              return (
                <button
                  key={`${row.name}-${index}`}
                  type="button"
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onClick={() => onOpen(row.name, 'Geographical distribution drilldown', row.rows || [])}
                  className={`group w-full text-left transition ${dimmed ? 'opacity-25' : 'opacity-100'}`}
                >
                  <div className="mb-1.5 flex items-center gap-2.5">
                    <span
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-[9px] font-black text-white"
                      style={{ backgroundColor: color }}
                    >
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <MapPin size={11} className="shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate text-[9px] font-bold text-slate-700">{row.name}</span>
                    <span className="shrink-0 text-[9px] font-black text-slate-950">{fmtCur(row.value)}</span>
                  </div>

                  <div className="ml-[54px] h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${width}%`, backgroundColor: color }}
                    />
                  </div>

                  <div className="ml-[54px] mt-1 flex items-center justify-between text-[8px] text-slate-400">
                    <span>{fmtNum(row.count || row.rows?.length || 0)} tenders</span>
                    <span>{share.toFixed(1)}% of value</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="grid h-[250px] place-items-center text-xs text-slate-400">No geography data</div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Main report
// -----------------------------------------------------------------------------

export default function TendersReportView() {
  const { error: showError } = useToast()
  const [filters, setFilters] = useState<TFilters>(EMPTY)
  const [filterOpts, setFilterOpts] = useState<FilterOpts | null>(null)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [activeDistributionTab, setActiveDistributionTab] =
    useState<DistributionTab>('Unit & Vertical')
  const [drilldown, setDrilldown] = useState<DrilldownRequest | null>(null)
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)
  const hasHydratedFiltersRef = useRef(false)

  const setFilter = (key: keyof TFilters, value: string) => {
    setFilters(current => ({ ...current, [key]: value }))
  }

  const buildParams = useCallback(
    (requestedPage = page) => {
      const params: Record<string, unknown> = { page: requestedPage, per_page: 50 }

      if (filters.preset !== 'custom' && filters.preset !== 'all') {
        params.preset = filters.preset
      } else {
        if (filters.date_from) params.date_from = filters.date_from
        if (filters.date_to) params.date_to = filters.date_to
      }

      const keys: (keyof TFilters)[] = [
        'status',
        'result',
        'source_portal',
        'tech_bid_eligible',
        'assigned_to',
        'customer_id',
        'product_name',
        'oem_name',
        'bid_min',
        'bid_max',
        'emd_required',
        'reverse_auction',
        'submission_from',
        'submission_to',
      ]

      keys.forEach(key => {
        if (filters[key]) params[key] = filters[key]
      })

      return params
    },
    [filters, page],
  )

  const runReport = useCallback(
    async (requestedPage = 1) => {
      setLoading(true)
      try {
        const response = await reportsApi.tenders(buildParams(requestedPage))
        setResult(response.data)
        setPage(requestedPage)
      } catch {
        showError('Failed to load tenders report')
      } finally {
        setLoading(false)
      }
    },
    [buildParams, showError],
  )

  useEffect(() => {
    reportsApi
      .tendersFilterOptions()
      .then(response => setFilterOpts(response.data))
      .catch(() => {})
    runReport(1)
  }, [])

  // Sync with the common date-range toolbar in ReportsPage. '' is the toolbar's
  // default "All Time" state and matches this view's own initial load, so it's
  // skipped; any other preset (including one already selected before this view
  // mounted, e.g. after switching tabs) is applied right away.
  const globalDr = useContext(ReportDateRangeCtx)
  useEffect(() => {
    if (!globalDr.preset) return
    setFilters(current => ({
      ...current,
      preset: globalDr.preset,
      date_from: globalDr.preset === 'custom' ? globalDr.date_from : '',
      date_to: globalDr.preset === 'custom' ? globalDr.date_to : '',
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalDr.preset, globalDr.date_from, globalDr.date_to])

  useEffect(() => {
    if (!hasHydratedFiltersRef.current) {
      hasHydratedFiltersRef.current = true
      return
    }

    const timeoutId = window.setTimeout(() => runReport(1), 300)
    return () => window.clearTimeout(timeoutId)
  }, [filters, runReport])

  const summary = result?.summary || {}
  const analytics = result?.analytics || {}
  const data = result?.data || []
  const pagination = result?.pagination || {
    total: 0,
    page: 1,
    per_page: 50,
    total_pages: 1,
  }
  const chartRes = result?.chart_data || []
  const chartStage = result?.pipeline_funnel || []
  const chartDaily = result?.chart_daily || []
  const chartTech = result?.chart_tech || []
  const upcoming = result?.upcoming_submissions || []
  const productAnalytics = result?.product_analytics || {}
  const productPerformance = productAnalytics.performance || []
  const productDemand = productAnalytics.demand || []

  const dailyComparison = useMemo(
    () => buildDailyComparison(data, chartDaily),
    [data, chartDaily],
  )

  const inputClass =
    'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-[12px] text-slate-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100'
  const labelClass = 'mb-1 block text-[11px] font-semibold text-slate-600'

  const columns: Column<Record<string, unknown>>[] = [
    {
      key: 'tender_num',
      header: 'Tender #',
      sortable: true,
      searchable: true,
      minWidth: '120px',
      hidden: true,
    },
    {
      key: 'tender_title',
      header: 'Title',
      sortable: true,
      searchable: true,
      minWidth: '160px',
      render: value => (
        <span title={String(value || '')} className="text-xs text-slate-700">
          {String(value || '').slice(0, 60)}
          {String(value || '').length > 60 ? '…' : ''}
        </span>
      ),
    },
    { key: 'customer_name', header: 'Customer', sortable: true, searchable: true },
    {
      key: 'source_portal',
      header: 'Portal',
      sortable: true,
      render: value =>
        value ? (
          <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">
            {String(value)}
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        ),
    },
    {
      key: 'tender_status',
      header: 'Status',
      sortable: true,
      render: value => <StatusBadge status={String(value || '')} />,
    },
    {
      key: 'result',
      header: 'Result',
      sortable: true,
      render: value => <StatusBadge status={String(value || 'Pending')} />,
    },
    { key: 'submission_date', header: 'Submission', sortable: true },
    {
      key: 'days_to_submission',
      header: 'Due In',
      sortable: true,
      align: 'center',
      render: value => {
        const number = Number(value)
        if (value == null) return <span className="text-slate-300">—</span>
        const className =
          number < 0
            ? 'bg-red-50 text-red-600'
            : number <= 3
              ? 'bg-orange-50 text-orange-600'
              : number <= 7
                ? 'bg-amber-50 text-amber-700'
                : 'bg-emerald-50 text-emerald-700'
        return (
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${className}`}>
            {number < 0 ? `${Math.abs(number)}d ago` : `${number}d`}
          </span>
        )
      },
    },
    {
      key: 'bid_amount',
      header: 'Our Bid',
      sortable: true,
      align: 'right',
      render: value => <span className="font-semibold">{fmtCur(value)}</span>,
    },
    {
      key: 'est_value',
      header: 'Est. Value',
      sortable: true,
      align: 'right',
      hidden: true,
      render: value => fmtCur(value),
    },
    {
      key: 'emd_amount',
      header: 'EMD',
      sortable: true,
      align: 'right',
      render: value => fmtCur(value),
    },
    {
      key: 'pbg_amount',
      header: 'PBG',
      sortable: true,
      align: 'right',
      hidden: true,
      render: value => fmtCur(value),
    },
    {
      key: 'tech_bid_eligible',
      header: 'Tech Bid',
      sortable: true,
      render: value =>
        value ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              value === 'Eligible'
                ? 'bg-emerald-50 text-emerald-700'
                : value === 'Not Eligible'
                  ? 'bg-red-50 text-red-600'
                  : 'bg-slate-100 text-slate-500'
            }`}
          >
            {String(value)}
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        ),
    },
    {
      key: 'products_boq',
      header: 'Products',
      sortable: false,
      searchable: true,
      hidden: true,
      render: value => (
        <span title={String(value || '')} className="text-xs text-slate-600">
          {String(value || '').slice(0, 50)}
          {String(value || '').length > 50 ? '…' : ''}
        </span>
      ),
    },
    {
      key: 'oems_boq',
      header: 'OEMs',
      sortable: false,
      searchable: true,
      hidden: true,
      render: value => (
        <span title={String(value || '')} className="text-xs text-slate-600">
          {String(value || '').slice(0, 50)}
          {String(value || '').length > 50 ? '…' : ''}
        </span>
      ),
    },
    { key: 'reverse_auction', header: 'RA', sortable: true, align: 'center', hidden: true },
    { key: 'assigned_to', header: 'Assigned To', sortable: true, searchable: true },
    { key: 'created_at', header: 'Created', sortable: true },
  ]

  const productDrillColumns: Column<Record<string, unknown>>[] = [
    { key: 'product_name', header: 'Product' },
    { key: 'tender_num', header: 'Tender Number' },
    { key: 'tender_title', header: 'Tender' },
    { key: 'customer_name', header: 'Customer' },
    { key: 'quantity', header: 'Quantity', align: 'right' },
    {
      key: 'product_value',
      header: 'BOQ Value',
      align: 'right',
      render: value => fmtCur(value),
    },
    { key: 'oem_name', header: 'OEM' },
    { key: 'tender_status', header: 'Status' },
    { key: 'result', header: 'Result' },
    { key: 'submission_date', header: 'Submission' },
    { key: 'assigned_to', header: 'Owner' },
  ]

  const openTenderRow = (row: Record<string, unknown>) => {
    const id = row.id ?? row.tender_id
    if (id == null || id === '') return

    setDrilldown({
      entity: 'tender',
      id: String(id),
      label: String(row.tender_title || row.tender_num || 'Tender'),
      seedRow: row,
    })
  }

  const openList = (title: string, sub: string, rows: any[]) => {
    setListDrill({ title, sub, rows, columns: columns as any })
  }

  const openProductList = (title: string, sub: string, rows: any[]) => {
    setListDrill({ title, sub, rows, columns: productDrillColumns as any })
  }

  return (
    <div className="space-y-4 bg-[#F8FAFC]">
      {/* Filters: exact simple row from the reference image. No advanced filters or saved views. */}
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div>
            <label className={labelClass}>Period</label>
            <select
              value={filters.preset}
              onChange={event => setFilter('preset', event.target.value)}
              className={inputClass}
            >
              {PRESETS.map(preset => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Status</label>
            <select
              value={filters.status}
              onChange={event => setFilter('status', event.target.value)}
              className={inputClass}
            >
              <option value="">All Statuses</option>
              {(filterOpts?.statuses || [
                'Aligned',
                'Evaluation',
                'Pre-Bid',
                'Reverse Auction',
                'Submitted',
                'Closed',
              ]).map(status => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass}>Result</label>
            <select
              value={filters.result}
              onChange={event => setFilter('result', event.target.value)}
              className={inputClass}
            >
              <option value="">All Results</option>
              {(filterOpts?.results || ['Pending', 'Won', 'Lost', 'Cancelled']).map(resultName => (
                <option key={resultName} value={resultName}>
                  {resultName}
                </option>
              ))}
            </select>
          </div>

          <MultiSelect
            label="Portal"
            options={(filterOpts?.portals || []).map(portal => ({ id: portal, name: portal }))}
            value={filters.source_portal}
            onChange={value => setFilter('source_portal', value)}
          />

          <MultiSelect
            label="Assigned To"
            options={filterOpts?.users || []}
            value={filters.assigned_to}
            onChange={value => setFilter('assigned_to', value)}
          />
        </div>

        {filters.preset === 'custom' && (
          <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 xl:max-w-[520px]">
            <div>
              <label className={labelClass}>From</label>
              <input
                type="date"
                value={filters.date_from}
                onChange={event => setFilter('date_from', event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>To</label>
              <input
                type="date"
                value={filters.date_to}
                onChange={event => setFilter('date_to', event.target.value)}
                className={inputClass}
              />
            </div>
          </div>
        )}
      </div>

      {result && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard
              label="Total Tenders"
              value={fmtNum(summary.total)}
              trend={summary.trend_total}
              icon={<FileText size={17} className="text-violet-600" />}
              borderClass="border-violet-100"
              sub="All time"
            />
            <KpiCard
              label="Won"
              value={fmtNum(summary.won)}
              trend={summary.trend_won}
              icon={<CheckCircle2 size={17} className="text-emerald-600" />}
              borderClass="border-emerald-100"
              sub={`${fmtPct(summary.win_rate)} win rate`}
            />
            <KpiCard
              label="Total Bid Value"
              value={fmtCur(summary.total_bid_value)}
              trend={summary.trend_bid}
              icon={<DollarSign size={17} className="text-blue-600" />}
              borderClass="border-blue-100"
              sub={`Avg ${fmtCur(summary.avg_bid)}`}
            />
            <KpiCard
              label="EMD at Risk"
              value={fmtCur(summary.emd_at_risk)}
              icon={<AlertCircle size={17} className="text-amber-600" />}
              borderClass="border-amber-100"
              sub="Pending tenders"
            />
            <KpiCard
              label="Bid/Est Ratio"
              value={summary.bid_to_est_ratio != null ? `${summary.bid_to_est_ratio}%` : '—'}
              icon={<Target size={17} className="text-indigo-600" />}
              borderClass="border-indigo-100"
              sub={`Est: ${fmtCur(summary.total_est_value)}`}
            />
          </div>

          {/* First analytics row: complete tender performance overview */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
            <TenderOutcomeCard
              summary={summary}
              chartStage={chartStage}
              chartRes={chartRes}
              dataRows={data}
              onOpen={openList}
            />
            <ResultAnalysisCard chartRes={chartRes} dataRows={data} onOpen={openList} />
            <PortalPerformanceCard analytics={analytics} dataRows={data} onOpen={openList} />
            <TopAssignedUsersCard analytics={analytics} dataRows={data} onOpen={openList} />
          </div>

          {/* Second analytics row: product intelligence */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
              <CardHeader
                title="Product Performance in Tenders"
                subtitle="Won · Lost · Pending by product"
              />
              <ProductPerformancePanel rows={productPerformance} onOpen={openProductList} />
            </div>

            <div className="h-full rounded-xl border border-slate-200 bg-white p-4">
              <CardHeader
                title="Product Demand & BOQ Value"
                subtitle="Tender count · Quantity · Product line value"
              />
              <ProductDemandPanel rows={productDemand} onOpen={openProductList} />
            </div>
          </div>

          {/* Third analytics row: full-width tender distribution intelligence */}
          <TenderDistributionComparison
            analytics={analytics}
            dataRows={data}
            activeTab={activeDistributionTab}
            onTabChange={setActiveDistributionTab}
            onOpenRows={openList}
          />

          {/* 2-card comparison grid */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <DailyTrendCard rows={dailyComparison} allRows={data} onOpen={openList} />
            <PipelineStagesCard chartStage={chartStage} dataRows={data} onOpen={openList} />
          </div>

          {/* 2-card comparison grid */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <TechEligibilityCard chartTech={chartTech} dataRows={data} onOpen={openList} />
            <GeographicDistributionCard analytics={analytics} dataRows={data} onOpen={openList} />
          </div>

          {/* Upcoming submissions */}
          {upcoming.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-violet-200 bg-white">
              <div className="border-b border-slate-100 px-4 py-3">
                <p className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-[0.05em] text-violet-600">
                  <AlertCircle size={12} /> Upcoming Submissions (Next 30 Days)
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/70">
                      {['Tender Title', 'Portal', 'Submission Date', 'Due In', 'Bid Amount'].map(
                        heading => (
                          <th
                            key={heading}
                            className="px-4 py-2 text-left text-[9px] font-bold uppercase tracking-wide text-slate-500"
                          >
                            {heading}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map((item: any, index: number) => (
                      <tr key={`${item.tender_title}-${index}`} className="border-b border-slate-50 last:border-0">
                        <td className="max-w-[260px] truncate px-4 py-2.5 text-[10px] font-semibold text-slate-800">
                          {item.tender_title || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-[10px] font-bold text-violet-600">{item.portal}</td>
                        <td className="px-4 py-2.5 text-[10px] text-slate-600">{item.submission_date}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                              item.days_to_submission <= 3
                                ? 'bg-red-100 text-red-600'
                                : item.days_to_submission <= 7
                                  ? 'bg-amber-100 text-amber-700'
                                  : 'bg-emerald-50 text-emerald-700'
                            }`}
                          >
                            {item.days_to_submission}d
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right text-[10px] font-black text-slate-900">
                          {fmtCur(item.bid_amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tender table */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
              <p className="text-xs font-semibold text-slate-700">
                {fmtNum(pagination.total)} tenders
                {pagination.total_pages > 1 && ` · Page ${pagination.page} of ${pagination.total_pages}`}
              </p>

              {pagination.total_pages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => runReport(page - 1)}
                    className="h-7 w-7 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                  >
                    ‹
                  </button>

                  {Array.from({ length: Math.min(5, pagination.total_pages) }, (_, index) => {
                    const targetPage =
                      Math.max(1, Math.min(pagination.total_pages - 4, page - 2)) + index
                    return (
                      <button
                        key={targetPage}
                        type="button"
                        onClick={() => runReport(targetPage)}
                        className={`h-7 w-7 rounded-lg text-xs font-medium ${
                          targetPage === page
                            ? 'bg-violet-600 text-white'
                            : 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {targetPage}
                      </button>
                    )
                  })}

                  <button
                    type="button"
                    disabled={page >= pagination.total_pages}
                    onClick={() => runReport(page + 1)}
                    className="h-7 w-7 rounded-lg border border-slate-200 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-30"
                  >
                    ›
                  </button>
                </div>
              )}
            </div>

            <DataTable
              columns={columns}
              data={data}
              loading={loading}
              emptyMessage="No tenders match the current filters"
              onRowClick={openTenderRow}
            />
          </div>
        </>
      )}

      {!result && loading && (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={24} className="animate-spin text-violet-500" />
        </div>
      )}

      <RecordViewPanel request={drilldown} onClose={() => setDrilldown(null)} />
      <ListDrilldownModal
        request={listDrill}
        onClose={() => setListDrill(null)}
        onRowClick={row => {
          setListDrill(null)
          openTenderRow(row)
        }}
      />
    </div>
  )
}