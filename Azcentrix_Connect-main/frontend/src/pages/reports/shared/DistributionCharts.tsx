/**
 * DistributionCharts.tsx — Shared distribution chart components and section
 * used across Tenders, Leads, Opportunities, Quotations, Work Orders, EMD/BG.
 *
 * Chart types:
 * Lollipop, Bubble, Donut, Trend, DimensionPanel
 *
 * Section:
 * DistributionSection — 2-tab layout
 * Unit & Vertical / Source & Segment
 */

import { useState, type ReactNode } from 'react'
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DistributionRow = {
  name: string
  value: number
  count: number
  won: number
  decided: number
  conversion: number
  trend: number[]
  color: string
  rows: any[]
}

export type DistChartType =
  | 'lollipop'
  | 'bubble'
  | 'donut'
  | 'trend'
  | 'ranked'

export interface DistributionModuleConfig {
  bu: DistChartType
  bv: DistChartType
  src: DistChartType
  seg: DistChartType
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DISTRIBUTION_COLORS = [
  '#1f66c2',
  '#2fae7d',
  '#8853c7',
  '#f1a11a',
  '#40a7bd',
  '#e75c7d',
]

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export const fmtCrDist = (value: number) =>
  `Rs ${value.toFixed(value >= 100 ? 0 : 1)} Cr`

export const fmtNumDist = (value: unknown) => {
  const numberValue = Number(value)

  return Number.isNaN(numberValue)
    ? '—'
    : numberValue.toLocaleString('en-IN')
}

function monthShort(key: string) {
  if (!key) return ''

  const [year, month] = key.split('-')
  const date = new Date(Number(year), Number(month) - 1, 1)

  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: '2-digit',
  })
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

export function toDistributionRows(
  items: any[],
  labelKey: string,
  trends: any[] = [],
): DistributionRow[] {
  const trendMap = new Map<string, number[]>(
    (trends || []).map(row => [
      String(row.name || ''),
      Array.isArray(row.trend) ? row.trend : [],
    ]),
  )

  return (items || []).slice(0, 6).map((row, index) => {
    const name = String(
      row[labelKey] ||
      row.name ||
      row.label ||
      'Unclassified',
    )

    const won = Number(row.won || 0)
    const lost = Number(row.lost || 0)
    const cancelled = Number(row.cancelled || 0)
    const decided = won + lost + cancelled

    const value =
      Math.round(
        (Number(
          row.est_value ||
          row.value ||
          0,
        ) / 1e7) * 10,
      ) / 10

    return {
      name,
      value,
      count: Number(
        row.tenders ||
        row.leads ||
        row.count ||
        0,
      ),
      won,
      decided,
      conversion: Number(
        row.win_rate ??
        row.success_rate ??
        (decided ? (won / decided) * 100 : 0),
      ),
      trend: trendMap.get(name) || [],
      color:
        DISTRIBUTION_COLORS[
          index % DISTRIBUTION_COLORS.length
        ],
      rows: [],
    }
  })
}

export function buildDistributionRowsFromData(
  rows: any[],
  months: string[],
  getName: (row: any) => string,
  getResult?: (row: any) => string,
  getValue?: (row: any) => number,
): DistributionRow[] {
  const groups: Record<string, any[]> = {}

  rows.forEach(row => {
    const key = getName(row) || 'Unclassified'

    if (!groups[key]) {
      groups[key] = []
    }

    groups[key].push(row)
  })

  return Object.entries(groups)
    .map(([name, group]) => {
      const resultGetter =
        getResult ||
        ((row: any) =>
          String(row.result || row.status || ''))

      const valueGetter =
        getValue ||
        ((row: any) =>
          Number(
            row.est_value ||
            row.bid_amount ||
            row.amount ||
            row.value ||
            0,
          ))

      const won = group.filter(row =>
        [
          'Won',
          'Converted',
          'Closed Won',
        ].includes(resultGetter(row)),
      ).length

      const decided = group.filter(row =>
        [
          'Won',
          'Lost',
          'Cancelled',
          'Converted',
          'Closed Won',
          'Closed Lost',
        ].includes(resultGetter(row)),
      ).length

      const value =
        Math.round(
          (
            group.reduce(
              (sum, row) =>
                sum + valueGetter(row),
              0,
            ) / 1e7
          ) * 10,
        ) / 10

      return {
        name,
        value,
        count: group.length,
        won,
        decided,
        conversion: decided
          ? (won / decided) * 100
          : 0,
        trend: months.map(month =>
          Math.round(
            (
              group
                .filter(
                  row =>
                    String(
                      row.created_at || '',
                    ).slice(0, 7) === month,
                )
                .reduce(
                  (sum, row) =>
                    sum + valueGetter(row),
                  0,
                ) / 1e7
            ) * 10,
          ) / 10,
        ),
        color: DISTRIBUTION_COLORS[0],
        rows: group,
      }
    })
    .sort(
      (a, b) =>
        b.value - a.value ||
        b.count - a.count,
    )
    .slice(0, 6)
    .map((row, index) => ({
      ...row,
      color:
        DISTRIBUTION_COLORS[
          index % DISTRIBUTION_COLORS.length
        ],
    }))
}

export function monthsFromRows(
  rows: any[],
): string[] {
  return Array.from(
    new Set(
      rows
        .map(row =>
          String(
            row.created_at || '',
          ).slice(0, 7),
        )
        .filter(Boolean),
    ),
  )
    .sort()
    .slice(-6)
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyChart({
  message,
  height = 260,
}: {
  message: string
  height?: number
}) {
  return (
    <div
      className="grid place-items-center text-xs text-gray-400"
      style={{ height }}
    >
      {message}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart: Ranked list
// ---------------------------------------------------------------------------

export function DimensionPanel({
  rows,
  dimension,
  onOpen,
}: {
  rows: DistributionRow[]
  dimension: string
  onOpen: (row: DistributionRow) => void
}) {
  type Metric =
    | 'count'
    | 'value'
    | 'conversion'

  const [metric, setMetric] =
    useState<Metric>('value')

  const top5 = rows.slice(0, 5)

  const maxCount = Math.max(
    ...top5.map(row => row.count),
    1,
  )

  const maxValue = Math.max(
    ...top5.map(row => row.value),
    1,
  )

  const maxConversion = Math.max(
    ...top5.map(row => row.conversion),
    1,
  )

  const getBarWidth = (
    row: DistributionRow,
  ) => {
    if (metric === 'count') {
      return (row.count / maxCount) * 100
    }

    if (metric === 'value') {
      return (row.value / maxValue) * 100
    }

    return (
      row.conversion /
      Math.max(maxConversion, 1)
    ) * 100
  }

  const getDisplayValue = (
    row: DistributionRow,
  ) => {
    if (metric === 'count') {
      return fmtNumDist(row.count)
    }

    if (metric === 'value') {
      return fmtCrDist(row.value)
    }

    return `${row.conversion.toFixed(1)}%`
  }

  const metricLabel =
    metric === 'count'
      ? 'count'
      : metric === 'value'
        ? 'pipeline value'
        : 'win rate'

  if (!top5.length) {
    return (
      <EmptyChart
        message={`No ${dimension} data available`}
        height={280}
      />
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          {(
            [
              'count',
              'value',
              'conversion',
            ] as Metric[]
          ).map(item => (
            <button
              key={item}
              type="button"
              onClick={() => setMetric(item)}
              className={[
                'rounded-md px-3 py-1.5',
                'text-[11px] font-bold capitalize',
                'transition',
                metric === item
                  ? 'bg-white text-blue-700 shadow-sm'
                  : 'text-gray-500 hover:text-gray-800',
              ].join(' ')}
            >
              {item === 'conversion'
                ? 'Conversion'
                : item.charAt(0).toUpperCase() +
                  item.slice(1)}
            </button>
          ))}
        </div>

        <span className="text-[10px] text-gray-400">
          Top {top5.length} by {metricLabel}
        </span>
      </div>

      <div className="space-y-3">
        {top5.map((row, index) => (
          <button
            key={row.name}
            type="button"
            onClick={() => onOpen(row)}
            className={[
              'group w-full rounded-[11px]',
              'border border-gray-100 bg-white p-3',
              'text-left transition',
              'hover:border-blue-200 hover:shadow-sm',
            ].join(' ')}
          >
            <div className="mb-2 flex items-center gap-3">
              <span
                className={[
                  'flex h-7 w-7 shrink-0',
                  'items-center justify-center',
                  'rounded-lg text-[11px] font-black',
                  index < 3
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-500',
                ].join(' ')}
              >
                {String(index + 1).padStart(
                  2,
                  '0',
                )}
              </span>

              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-bold text-gray-900">
                  {row.name}
                </div>

                <div className="mt-0.5 text-[10px] text-gray-400">
                  {fmtNumDist(row.count)} records
                  {' · '}
                  {fmtCrDist(row.value)}
                  {' · '}
                  {row.conversion.toFixed(0)}%
                  conversion
                </div>
              </div>

              <div className="text-right">
                <div className="text-[13px] font-black text-gray-900">
                  {getDisplayValue(row)}
                </div>

                <div className="text-[9px] text-gray-400">
                  {metricLabel}
                </div>
              </div>
            </div>

            <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${getBarWidth(row)}%`,
                  backgroundColor: row.color,
                }}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart: Lollipop
// ---------------------------------------------------------------------------

export function DistributionLollipop({
  rows,
  onOpen,
  xAxisLabel = 'Pipeline Value (Cr)',
  yAxisLabel = 'Business Unit',
}: {
  rows: DistributionRow[]
  onOpen: (row: DistributionRow) => void
  xAxisLabel?: string
  yAxisLabel?: string
}) {
  const max = Math.max(
    ...rows.map(row => row.value),
    1,
  )

  if (!rows.length) {
    return (
      <EmptyChart
        message="No data available"
        height={280}
      />
    )
  }

  const rowHeight = 36
  const rowGap = 8

  const chartHeight = Math.max(
    rows.length * rowHeight +
    (rows.length - 1) * rowGap +
    54,
    180,
  )

  return (
   <div
  className="relative h-full min-h-[290px] overflow-hidden pb-12 pl-[122px] pr-16 pt-7"
  style={{ height: Math.max(chartHeight, 290) }}
>
      {/* Y-axis title */}
      <span
        className={[
          'absolute left-1 top-1/2',
          '-translate-y-1/2 -rotate-90',
          'whitespace-nowrap text-[9px]',
          'font-bold uppercase tracking-wide',
          'text-gray-400',
        ].join(' ')}
      >
        {yAxisLabel}
      </span>

      {/* X-axis title */}
      <span
        className={[
          'absolute bottom-1 left-[58%]',
          '-translate-x-1/2',
          'whitespace-nowrap text-[9px]',
          'font-bold uppercase tracking-wide',
          'text-gray-400',
        ].join(' ')}
      >
        {xAxisLabel}
      </span>

      {/* Axis lines */}
      <div className="absolute bottom-9 left-[122px] right-12 top-7 border-b border-l border-gray-300" />

      {/* Axis start value */}
      <span className="absolute bottom-5 left-[119px] text-[8px] font-semibold text-gray-400">
        0
      </span>

      {/* Axis maximum value */}
      <span className="absolute bottom-5 right-10 text-[8px] font-semibold text-gray-400">
        {max.toFixed(max >= 100 ? 0 : 1)}
      </span>

      <div className="relative space-y-2">
        {rows.map(row => {
          const width = Math.max(
            8,
            (row.value / max) * 78,
          )

          return (
            <button
              key={row.name}
              type="button"
              onClick={() => onOpen(row)}
              title={`${row.name}: ${fmtCrDist(row.value)}`}
              className={[
                'group relative flex h-9 w-full',
                'items-center text-left',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute -left-[112px]',
                  'w-[102px] truncate text-right',
                  'text-[10px] font-semibold',
                  'text-gray-600',
                ].join(' ')}
              >
                {row.name}
              </span>

              <span
                className="relative h-[3px] rounded-full transition-opacity group-hover:opacity-80"
                style={{
                  width: `${width}%`,
                  backgroundColor: row.color,
                }}
              >
                <span
                  className={[
                    'absolute -right-2 top-1/2',
                    'h-4 w-4 -translate-y-1/2',
                    'rounded-full border-[3px]',
                    'border-white shadow',
                    'ring-1 ring-gray-200',
                    'transition-transform',
                    'group-hover:scale-125',
                  ].join(' ')}
                  style={{
                    backgroundColor: row.color,
                  }}
                />

                <span
                  className={[
                    'absolute -right-[58px]',
                    'top-1/2 -translate-y-1/2',
                    'whitespace-nowrap',
                    'text-[10px] font-extrabold',
                    'text-gray-800',
                  ].join(' ')}
                >
                  {row.value.toFixed(1)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart: Bubble
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Chart: Bubble
// ---------------------------------------------------------------------------

export function DistributionBubble({
  rows,
  onOpen,
  xAxisLabel = 'Business Vertical',
  yAxisLabel = 'Record Count',
}: {
  rows: DistributionRow[]
  onOpen: (row: DistributionRow) => void
  xAxisLabel?: string
  yAxisLabel?: string
}) {
  if (!rows.length) {
    return (
      <EmptyChart
        message="No data available"
        height={220}
      />
    )
  }

  const sortedRows = [...rows]
    .sort(
      (a, b) =>
        a.count - b.count ||
        a.value - b.value,
    )
    .slice(0, 6)

  const maxCount = Math.max(
    ...sortedRows.map(row => row.count),
    1,
  )

  /*
   * Reduced size range so all six bubbles fit
   * inside the chart without clipping.
   */
  const minDiameter = 48
  const maxDiameter = 92

  const getDiameter = (count: number) => {
    const normalized =
      maxCount > 0
        ? count / maxCount
        : 0

    return (
      minDiameter +
      normalized *
        (maxDiameter - minDiameter)
    )
  }

  return (
    <div className="relative h-full min-h-[290px] w-full overflow-hidden pb-9 pl-14 pr-5 pt-4">
      {/* Y-axis title */}
      <span
        className="
          absolute left-1 top-[48%]
          -translate-y-1/2 -rotate-90
          whitespace-nowrap
          text-[10px] font-bold uppercase
          tracking-wide text-slate-400
        "
      >
        {yAxisLabel}
      </span>

      {/* X-axis title */}
      <span
        className="
          absolute bottom-0 left-[55%]
          -translate-x-1/2
          whitespace-nowrap
          text-[10px] font-bold uppercase
          tracking-wide text-slate-400
        "
      >
        {xAxisLabel}

        <span className="ml-1 normal-case tracking-normal">
          (smallest → largest)
        </span>
      </span>

      {/* Axis lines */}
      <div
        className="
          pointer-events-none
          absolute bottom-8 left-14 right-5 top-4
          border-b border-l border-slate-300
        "
      />

      {/* Bubble row */}
      <div
        className="
          relative z-10
          flex h-full w-full
          items-center justify-between
          gap-2 overflow-visible
          px-4 pb-2
        "
      >
        {sortedRows.map(row => {
          const diameter =
            getDiameter(row.count)

          const isSmall =
            diameter <= 58

          return (
            <button
              key={row.name}
              type="button"
              onClick={() => onOpen(row)}
              title={[
                row.name,
                `${fmtNumDist(row.count)} records`,
                fmtCrDist(row.value),
                `${row.conversion.toFixed(1)}% conversion`,
              ].join(' · ')}
              className="
                grid shrink-0 place-items-center
                rounded-full
                border-2 border-white
                text-center
                font-extrabold
                leading-[1.1] text-white
                shadow-md
                transition-all duration-200
                hover:z-20 hover:scale-105
                hover:shadow-lg
                focus:outline-none
                focus:ring-2
                focus:ring-blue-300
              "
              style={{
                width: `${diameter}px`,
                height: `${diameter}px`,
                minWidth: `${diameter}px`,
                minHeight: `${diameter}px`,
                maxWidth: `${diameter}px`,
                maxHeight: `${diameter}px`,
                flex: `0 0 ${diameter}px`,
                aspectRatio: '1 / 1',
                padding: isSmall
                  ? '5px'
                  : '8px',
                fontSize: isSmall
                  ? '8px'
                  : '9px',
                backgroundColor: row.color,
              }}
            >
              <span
                className="
                  block w-full
                  break-words text-center
                  whitespace-normal
                "
                style={{
                  overflowWrap: 'anywhere',
                  wordBreak: 'break-word',
                }}
              >
                {row.name}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
// ---------------------------------------------------------------------------
// Chart: Donut
// ---------------------------------------------------------------------------

export function DistributionDonut({
  rows,
  onOpen,
}: {
  rows: DistributionRow[]
  onOpen: (row: DistributionRow) => void
}) {
  const [active, setActive] =
    useState<string | null>(null)

  if (!rows.length) {
    return (
      <EmptyChart
        message="No data available"
        height={260}
      />
    )
  }

  const total =
    rows.reduce(
      (sum, row) => sum + row.value,
      0,
    ) || 1

  const data = rows.map(row => ({
    name: row.name,
    value: row.value,
    color: row.color,
    row,
  }))

  const activeRow = rows.find(
    row => row.name === active,
  )

  return (
    <div className="flex min-h-[250px] items-center gap-4 overflow-hidden">
      <div className="relative h-[220px] w-[220px] shrink-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
        >
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={90}
              paddingAngle={2}
              dataKey="value"
              onMouseEnter={(_, index) =>
                setActive(
                  data[index]?.name ?? null,
                )
              }
              onMouseLeave={() =>
                setActive(null)
              }
              onClick={(entry: any) =>
                onOpen(entry.row)
              }
              style={{
                cursor: 'pointer',
              }}
            >
              {data.map(entry => (
                <Cell
                  key={entry.name}
                  fill={entry.color}
                  opacity={
                    active &&
                    active !== entry.name
                      ? 0.35
                      : 1
                  }
                  stroke="white"
                  strokeWidth={2}
                />
              ))}
            </Pie>

            <Tooltip
              content={({
                active: tooltipActive,
                payload,
              }: any) => {
                if (
                  !tooltipActive ||
                  !payload?.length
                ) {
                  return null
                }

                const item =
                  payload[0].payload

                return (
                  <div className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs shadow-lg">
                    <p className="font-bold text-gray-800">
                      {item.name}
                    </p>

                    <p className="text-gray-600">
                      {fmtCrDist(item.value)}
                      {' · '}
                      {(
                        (item.value / total) *
                        100
                      ).toFixed(1)}
                      %
                    </p>
                  </div>
                )
              }}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          {activeRow ? (
            <>
              <span className="max-w-[80px] truncate text-center text-[11px] font-bold leading-tight text-gray-600">
                {activeRow.name}
              </span>

              <span className="text-[16px] font-black text-gray-900">
                {(
                  (activeRow.value / total) *
                  100
                ).toFixed(0)}
                %
              </span>
            </>
          ) : (
            <>
              <span className="text-[10px] text-gray-400">
                Total
              </span>

              <span className="text-[15px] font-black text-gray-900">
                {fmtCrDist(total)}
              </span>
            </>
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-gray-400">
          Share of total pipeline
        </p>

        <div className="space-y-1.5">
          {rows.slice(0, 6).map(row => (
            <button
              key={row.name}
              type="button"
              onClick={() => onOpen(row)}
              onMouseEnter={() =>
                setActive(row.name)
              }
              onMouseLeave={() =>
                setActive(null)
              }
              className={[
                'flex w-full items-center',
                'gap-2 rounded-lg px-2 py-1.5',
                'text-left transition',
                active === row.name
                  ? 'bg-gray-50'
                  : 'hover:bg-gray-50',
              ].join(' ')}
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{
                  backgroundColor:
                    row.color,
                }}
              />

              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-700">
                {row.name}
              </span>

              <span className="shrink-0 text-[10px] font-bold text-gray-800">
                {fmtCrDist(row.value)}
              </span>

              <span className="w-10 shrink-0 text-right text-[10px] text-gray-400">
                {(
                  (row.value / total) *
                  100
                ).toFixed(0)}
                %
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart: Trend
// ---------------------------------------------------------------------------

export function DistributionTrend({
  rows,
  months,
  onOpen,
  xAxisLabel = 'Month',
  yAxisLabel = 'Pipeline Value (Cr)',
}: {
  rows: DistributionRow[]
  months: string[]
  onOpen: (row: DistributionRow) => void
  xAxisLabel?: string
  yAxisLabel?: string
}) {
  const topRows = rows

  const values = topRows.flatMap(
    row => row.trend,
  )

  const max =
    Math.max(...values, 1) * 1.1

  const width = 600
  const height = 260

  const getX = (index: number) =>
    months.length > 1
      ? 32 +
        index *
        ((width - 56) /
          (months.length - 1))
      : width / 2

  const getY = (value: number) =>
    222 -
    (value / max) * 190 +
    12

  if (
    !topRows.length ||
    !months.length
  ) {
    return (
      <EmptyChart
        message="No trend data"
        height={260}
      />
    )
  }

  return (
    <div className="overflow-hidden">
      <div className="mb-2 flex flex-wrap gap-3">
        {topRows.map(row => (
          <button
            key={row.name}
            type="button"
            onClick={() => onOpen(row)}
            className="inline-flex items-center gap-1.5 text-[9px] font-bold text-gray-500 hover:text-gray-900"
          >
            <i
              className="h-2.5 w-2.5 rounded-full"
              style={{
                backgroundColor:
                  row.color,
              }}
            />

            <span className="max-w-[130px] truncate">
              {row.name}
            </span>

            <span className="text-gray-400">
              ({fmtNumDist(row.count)})
            </span>
          </button>
        ))}
      </div>

      <div className="flex">
        <div className="flex w-10 shrink-0 items-center justify-center">
          <span
            className={[
              'origin-center -rotate-90',
              'whitespace-nowrap text-[9px]',
              'font-bold uppercase tracking-wide',
              'text-gray-400',
            ].join(' ')}
          >
            {yAxisLabel}
          </span>
        </div>

        <div className="relative mr-3 h-[260px] flex-1 border-b border-l border-gray-300">
        <span
          className={[
            'absolute -bottom-7 left-1/2',
            '-translate-x-1/2',
            'whitespace-nowrap text-[9px]',
            'font-bold uppercase tracking-wide',
            'text-gray-400',
          ].join(' ')}
        >
          {xAxisLabel}
        </span>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="h-full w-full overflow-visible"
        >
          {[0.25, 0.5, 0.75].map(
            percentage => {
              const y = getY(
                max * percentage,
              )

              return (
                <line
                  key={percentage}
                  x1="0"
                  x2={width}
                  y1={y}
                  y2={y}
                  stroke="#e5e7eb"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
              )
            },
          )}

          {months.map(
            (month, index) => (
              <text
                key={month}
                x={getX(index)}
                y={254}
                textAnchor="middle"
                fontSize="10"
                fill="#718198"
              >
                {monthShort(month)}
              </text>
            ),
          )}

          {topRows.map(row => (
            <g
              key={row.name}
              onClick={() => onOpen(row)}
              className="cursor-pointer"
            >
              <polyline
                fill="none"
                stroke={row.color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={row.trend
                  .map(
                    (value, index) =>
                      `${getX(index)},${getY(value)}`,
                  )
                  .join(' ')}
              />

              {row.trend.map(
                (value, index) => (
                  <circle
                    key={`${row.name}-${index}`}
                    cx={getX(index)}
                    cy={getY(value)}
                    r="4.5"
                    fill="#ffffff"
                    stroke={row.color}
                    strokeWidth="3"
                  />
                ),
              )}
            </g>
          ))}
        </svg>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ChartPanel wrapper
// ---------------------------------------------------------------------------

function ChartPanel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-bold uppercase tracking-wider text-gray-500">
            {title}
          </p>

          <p className="mt-0.5 text-[10px] text-gray-400">
            {subtitle}
          </p>
        </div>

        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-1 text-[9px] font-extrabold text-gray-500">
          Drilldown
        </span>
      </div>

      <div className="min-w-0 flex-1">
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Axis-label helpers
// ---------------------------------------------------------------------------

function getDimensionAxisLabel(
  dimension: string,
) {
  if (dimension === 'Business Unit') {
    return 'Business Unit'
  }

  if (dimension === 'Business Vertical') {
    return 'Business Vertical'
  }

  if (dimension === 'Source') {
    return 'Lead Source'
  }

  if (dimension === 'Customer Segment') {
    return 'Customer Segment'
  }

  return dimension
}

// ---------------------------------------------------------------------------
// Render chart by type
// ---------------------------------------------------------------------------

function RenderChart({
  type,
  rows,
  months,
  onOpen,
  dimension,
}: {
  type: DistChartType
  rows: DistributionRow[]
  months: string[]
  onOpen: (row: DistributionRow) => void
  dimension: string
}) {
  const dimensionLabel =
    getDimensionAxisLabel(dimension)

  if (type === 'lollipop') {
    return (
      <DistributionLollipop
        rows={rows}
        onOpen={onOpen}
        xAxisLabel="Pipeline Value (Cr)"
        yAxisLabel={dimensionLabel}
      />
    )
  }

  if (type === 'bubble') {
    return (
      <DistributionBubble
        rows={rows}
        onOpen={onOpen}
        xAxisLabel={dimensionLabel}
        yAxisLabel="Record Count"
      />
    )
  }

  if (type === 'donut') {
    return (
      <DistributionDonut
        rows={rows}
        onOpen={onOpen}
      />
    )
  }

  if (type === 'trend') {
    return (
      <DistributionTrend
        rows={rows}
        months={months}
        onOpen={onOpen}
        xAxisLabel="Month"
        yAxisLabel="Pipeline Value (Cr)"
      />
    )
  }

  return (
    <DimensionPanel
      rows={rows}
      dimension={dimension}
      onOpen={onOpen}
    />
  )
}

// ---------------------------------------------------------------------------
// Chart subtitles
// ---------------------------------------------------------------------------

const CHART_SUBTITLE: Record<
  DistChartType,
  string
> = {
  lollipop:
    'Pipeline value comparison from highest to lowest',
  bubble:
    'Bubble size represents record count',
  donut:
    'Proportional pipeline value breakdown',
  trend:
    'Monthly pipeline value trend',
  ranked:
    'Ranked by pipeline value, count and win rate',
}

// ---------------------------------------------------------------------------
// DistributionSection
// ---------------------------------------------------------------------------

export interface DistributionSectionProps {
  rows: any[]
  analytics?: any
  config: DistributionModuleConfig
  module: string
  getBU?: (row: any) => string
  getBV?: (row: any) => string
  getSrc?: (row: any) => string
  getSeg?: (row: any) => string
  getResult?: (row: any) => string
  getValue?: (row: any) => number
  onOpenRows?: (
    title: string,
    sub: string,
    rows: any[],
  ) => void
}

type DistTab =
  | 'Unit & Vertical'
  | 'Source & Segment'

export function DistributionSection({
  rows,
  analytics,
  config,
  module,
  getBU,
  getBV,
  getSrc,
  getSeg,
  getResult,
  getValue,
  onOpenRows,
}: DistributionSectionProps) {
  const [activeTab, setActiveTab] =
    useState<DistTab>(
      'Unit & Vertical',
    )

  const trends =
    analytics?.distribution_trends || {}

  const months =
    monthsFromRows(rows)

  const businessUnitRows =
    analytics?.business_units?.length
      ? toDistributionRows(
          analytics.business_units,
          'name',
          trends.business_units,
        )
      : buildDistributionRowsFromData(
          rows,
          months,
          getBU ||
            (row =>
              row.business_vertical ||
              row.business_unit ||
              'Unclassified'),
          getResult,
          getValue,
        )

  const businessVerticalRows =
    analytics?.business_verticals?.length
      ? toDistributionRows(
          analytics.business_verticals,
          'name',
          trends.business_verticals,
        )
      : buildDistributionRowsFromData(
          rows,
          months,
          getBV ||
            (row =>
              row.business_vertical_group ||
              row.business_vertical ||
              'Unclassified'),
          getResult,
          getValue,
        )

  const sourceRows =
    analytics?.portal_roi?.length
      ? toDistributionRows(
          analytics.portal_roi,
          'portal',
          trends.sources,
        )
      : buildDistributionRowsFromData(
          rows,
          months,
          getSrc ||
            (row =>
              row.source_portal ||
              row.source ||
              'Other'),
          getResult,
          getValue,
        )

  const segmentRows =
    analytics?.customer_segments?.length
      ? toDistributionRows(
          analytics.customer_segments,
          'name',
          trends.customer_segments,
        )
      : buildDistributionRowsFromData(
          rows,
          months,
          getSeg ||
            (row =>
              row.customer_segment ||
              'Unclassified'),
          getResult,
          getValue,
        )

  const openGroup =
    (dimension: string) =>
    (row: DistributionRow) => {
      onOpenRows?.(
        row.name,
        `${dimension} · ${module} drilldown`,
        row.rows || [],
      )
    }

  const tabs: DistTab[] = [
    'Unit & Vertical',
    'Source & Segment',
  ]

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-sm font-extrabold text-gray-900">
            Distribution Intelligence
          </h3>

          <p className="mt-1 text-[11px] text-gray-500">
            {module} distribution by
            business unit, vertical, source
            and customer segment.
          </p>
        </div>

        <span className="rounded-full bg-blue-50 px-3 py-1.5 text-[10px] font-extrabold text-blue-700">
          {activeTab}
        </span>
      </div>

      <div className="flex gap-1 overflow-hidden border-b border-gray-100 px-4 pt-2">
        {tabs.map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() =>
              setActiveTab(tab)
            }
            className={[
              'relative whitespace-nowrap',
              'px-4 py-3 text-[11px]',
              'font-extrabold transition',
              activeTab === tab
                ? 'text-blue-700'
                : 'text-gray-500 hover:text-gray-900',
            ].join(' ')}
          >
            {tab}

            {activeTab === tab && (
              <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-blue-700" />
            )}
          </button>
        ))}
      </div>

   <div className="overflow-hidden bg-[#f8fafd] p-4">
  {activeTab === 'Unit & Vertical' ? (
    <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 xl:grid-cols-2">
      <ChartPanel
        title="Business Unit"
        subtitle={CHART_SUBTITLE[config.bu]}
      >
        <RenderChart
          type={config.bu}
          rows={businessUnitRows}
          months={months}
          dimension="Business Unit"
          onOpen={openGroup('Business Unit')}
        />
      </ChartPanel>

      <ChartPanel
        title="Business Vertical"
        subtitle={CHART_SUBTITLE[config.bv]}
      >
        <RenderChart
          type={config.bv}
          rows={
            config.bv === 'lollipop'
              ? [...businessVerticalRows].reverse()
              : businessVerticalRows
          }
          months={months}
          dimension="Business Vertical"
          onOpen={openGroup('Business Vertical')}
        />
      </ChartPanel>
    </div>
  ) : (
    <div className="grid min-w-0 grid-cols-1 items-stretch gap-4 xl:grid-cols-2">
      <ChartPanel
        title="Source"
        subtitle={CHART_SUBTITLE[config.src]}
      >
        <RenderChart
          type={config.src}
          rows={sourceRows}
          months={months}
          dimension="Source"
          onOpen={openGroup('Source')}
        />
      </ChartPanel>

      <ChartPanel
        title="Customer Segment"
        subtitle={CHART_SUBTITLE[config.seg]}
      >
        <RenderChart
          type={config.seg}
          rows={segmentRows}
          months={months}
          dimension="Customer Segment"
          onOpen={openGroup('Customer Segment')}
        />
      </ChartPanel>
    </div>
  )}
</div>
    </section>
  )
}