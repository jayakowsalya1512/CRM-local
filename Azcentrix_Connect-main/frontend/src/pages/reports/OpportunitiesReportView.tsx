/**
 * OpportunitiesReportView.tsx — Opportunity Analytics report (Reports section).
 *
 * Editorial / infographic analytics redesign inspired by modern Behance, Canva,
 * and Visme report layouts.
 *
 * Existing API calls, filters, calculations, export, DataTable, and drilldown
 * behavior are preserved.
 *
 * Visual approach:
 * - No circles / donut charts
 * - No triangular funnel
 * - No standard line chart
 * - No standard bar chart
 * - Uses editorial KPI bands, stage journey, month tiles, quotation coverage
 *   matrix, ageing distribution, recovery command centre, and action list
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  TabSkeleton,
  ColDef,
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

function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()

  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.owner) p.set('assigned_to', f.owner)
  if (f.region) p.set('region', f.region)
  if (f.status) p.set('stage', f.status)
  if (f.customer_id) p.set('customer_id', f.customer_id)

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

const STAGE_ORDER = ['Opportunity', 'Request Conversion', 'Converted']
const OPEN_STAGES = ['Opportunity', 'Request Conversion']

type Accent = 'indigo' | 'emerald' | 'amber' | 'rose' | 'sky' | 'violet'

const ACCENTS: Record<
  Accent,
  {
    strip: string
    iconBg: string
    iconText: string
    softBg: string
    valueText: string
  }
> = {
  indigo: {
    strip: 'bg-[#244a73]',
    iconBg: 'bg-[#eef3f8]',
    iconText: 'text-[#244a73]',
    softBg: 'bg-[#f7f9fc]',
    valueText: 'text-[#244a73]',
  },
  emerald: {
    strip: 'bg-[#2f7d71]',
    iconBg: 'bg-[#edf6f4]',
    iconText: 'text-[#2f7d71]',
    softBg: 'bg-[#f4f9f8]',
    valueText: 'text-[#2f7d71]',
  },
  amber: {
    strip: 'bg-[#a8782a]',
    iconBg: 'bg-[#faf5e9]',
    iconText: 'text-[#8a651f]',
    softBg: 'bg-[#fcfaf4]',
    valueText: 'text-[#8a651f]',
  },
  rose: {
    strip: 'bg-[#a84a4a]',
    iconBg: 'bg-[#faf0f0]',
    iconText: 'text-[#9b3f3f]',
    softBg: 'bg-[#fcf7f7]',
    valueText: 'text-[#9b3f3f]',
  },
  sky: {
    strip: 'bg-[#5b7188]',
    iconBg: 'bg-[#f0f3f6]',
    iconText: 'text-[#4f657b]',
    softBg: 'bg-[#f7f9fb]',
    valueText: 'text-[#4f657b]',
  },
  violet: {
    strip: 'bg-[#6b7280]',
    iconBg: 'bg-[#f3f4f6]',
    iconText: 'text-[#5b6470]',
    softBg: 'bg-[#fafafa]',
    valueText: 'text-[#5b6470]',
  },
}

function Icon({
  name,
}: {
  name:
    | 'pipeline'
    | 'conversion'
    | 'risk'
    | 'age'
    | 'quote'
    | 'action'
    | 'source'
    | 'month'
}) {
  const cls = 'h-5 w-5'

  if (name === 'pipeline') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls}>
        <path d="M4 5h16M7 12h10M10 19h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }

  if (name === 'conversion') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls}>
        <path d="M5 17 10 12l3 3 6-7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M15 8h4v4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (name === 'risk') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls}>
        <path d="M12 8v5M12 17h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="m10.3 3.8-8 14a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z" stroke="currentColor" strokeWidth="2" />
      </svg>
    )
  }

  if (name === 'age') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls}>
        <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 4h14v16H5z" stroke="currentColor" strokeWidth="2" />
      </svg>
    )
  }

  if (name === 'quote') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls}>
        <path d="M6 3h9l3 3v15H6z" stroke="currentColor" strokeWidth="2" />
        <path d="M9 10h6M9 14h6M9 18h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }

  if (name === 'action') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls}>
        <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  if (name === 'source') {
    return (
      <svg viewBox="0 0 24 24" fill="none" className={cls}>
        <path d="M4 6h6v6H4zM14 12h6v6h-6zM14 3h6v6h-6zM4 15h6v6H4z" stroke="currentColor" strokeWidth="2" />
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" className={cls}>
      <path d="M5 4h14v16H5z" stroke="currentColor" strokeWidth="2" />
      <path d="M8 2v4M16 2v4M5 9h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function MetricCard({
  label,
  value,
  sub,
  accent,
  icon,
  onClick,
}: {
  label: string
  value: string
  sub: string
  accent: Accent
  icon: Parameters<typeof Icon>[0]['name']
  onClick?: () => void
}) {
  const a = ACCENTS[accent]

  return (
    <div
      onClick={onClick}
      className={`relative overflow-hidden rounded-[14px] border border-slate-200 bg-white p-4 shadow-[0_3px_14px_rgba(15,23,42,0.045)] ${
        onClick ? 'cursor-pointer transition hover:-translate-y-0.5 hover:shadow-[0_8px_22px_rgba(15,23,42,0.08)]' : ''
      }`}
    >
      <div className={`absolute left-0 top-0 h-full w-1 ${a.strip}`} />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 pl-1">
          <div className="truncate text-[10px] font-extrabold uppercase tracking-[0.09em] text-slate-500">
            {label}
          </div>
          <div className="mt-2 truncate text-[26px] font-black leading-none tracking-tight text-slate-950">
            {value}
          </div>
          <div className={`mt-3 truncate text-[10.5px] font-semibold ${a.valueText}`}>
            {sub}
          </div>
        </div>

        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] ${a.iconBg} ${a.iconText}`}>
          <Icon name={icon} />
        </div>
      </div>
    </div>
  )
}

function Panel({
  title,
  sub,
  icon,
  children,
  className = '',
}: {
  title: string
  sub?: string
  icon?: Parameters<typeof Icon>[0]['name']
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`flex h-full flex-col overflow-hidden rounded-[14px] border border-slate-200 bg-white shadow-[0_3px_14px_rgba(15,23,42,0.04)] ${className}`}>
      <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-3.5">
        {icon ? (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-slate-100 text-slate-700">
            <Icon name={icon} />
          </div>
        ) : null}

        <div>
          <div className="text-[13px] font-extrabold text-slate-900">{title}</div>
          {sub ? <div className="mt-1 text-[10.5px] leading-4 text-slate-500">{sub}</div> : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4">{children}</div>
    </section>
  )
}

function StageJourney({
  stages,
  total,
  onStageClick,
}: {
  stages: { key: string; name: string; value: number }[]
  total: number
  onStageClick?: (stage: { key: string; name: string; value: number }, index: number) => void
}) {
  const colors = [
    'from-[#244a73] to-[#3d6388]',
    'from-[#8a98a8] to-[#a9b3bd]',
    'from-[#2f7d71] to-[#4f948a]',
  ]

  return (
    <div className="space-y-3">
      {stages.map((stage, index) => {
        const percentage = pct(stage.value, total || 1)

        return (
          <div key={stage.key} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-stretch gap-3">
            <div className="flex items-center justify-center rounded-[10px] bg-slate-100 text-[11px] font-black text-slate-500">
              {String(index + 1).padStart(2, '0')}
            </div>

            <div
              onClick={onStageClick ? () => onStageClick(stage, index) : undefined}
              className={`relative min-h-[58px] overflow-hidden rounded-[11px] border border-slate-200 bg-slate-50 ${
                onStageClick ? 'cursor-pointer transition hover:border-slate-300' : ''
              }`}
            >
              <div
                className={`absolute inset-y-0 left-0 bg-gradient-to-r ${colors[index % colors.length]} opacity-95`}
                style={{ width: `${Math.max(percentage, stage.value ? 5 : 0)}%` }}
              />

              <div className="relative flex h-full items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-[11px] font-extrabold text-slate-900">{stage.name}</div>
                  <div className="mt-1 text-[9.5px] text-slate-500">Pipeline stage coverage</div>
                </div>

                <div className="text-right">
                  <div className="text-[18px] font-black text-slate-950">{fmtN(stage.value)}</div>
                  <div className="text-[9.5px] font-semibold text-slate-500">{percentage}%</div>
                </div>
              </div>
            </div>

            {index < stages.length - 1 ? (
              <div className="flex items-center text-slate-300">→</div>
            ) : (
              <div />
            )}
          </div>
        )
      })}
    </div>
  )
}

function MonthlyOpportunityPulse({
  data,
  onCreatedClick,
  onConvertedClick,
}: {
  data: { month: string; created: number; converted: number }[]
  onCreatedClick?: (month: string) => void
  onConvertedClick?: (month: string) => void
}) {
  const maxValue = Math.max(
    ...data.flatMap(item => [item.created, item.converted]),
    1,
  )

  const totals = data.reduce(
    (acc, item) => {
      acc.created += item.created
      acc.converted += item.converted
      return acc
    },
    { created: 0, converted: 0 },
  )

  const bestMonth = data.reduce<{
    month: string
    created: number
    converted: number
  } | null>((best, item) => {
    if (!best) return item

    const currentRate = pct(item.converted, item.created || 1)
    const bestRate = pct(best.converted, best.created || 1)

    return currentRate > bestRate ? item : best
  }, null)

  const formatMonth = (month: string) => {
    const [year, monthNumber] = month.split('-').map(Number)
    if (!year || !monthNumber) return month

    return new Intl.DateTimeFormat('en-IN', {
      month: 'short',
      year: 'numeric',
    }).format(new Date(year, monthNumber - 1, 1))
  }

  return (
    <div className="flex min-h-[240px] flex-col">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-[11px] border border-[#d8e1ea] bg-[#f4f7fa] px-3 py-2.5">
          <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-[#5f7183]">
            Created
          </div>
          <div className="mt-1 text-[22px] font-black text-[#244a73]">
            {fmtN(totals.created)}
          </div>
        </div>

        <div className="rounded-[11px] border border-[#d7e5e1] bg-[#f2f7f6] px-3 py-2.5">
          <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-[#5d756f]">
            Converted
          </div>
          <div className="mt-1 text-[22px] font-black text-[#2f7d71]">
            {fmtN(totals.converted)}
          </div>
        </div>

        <div className="rounded-[11px] border border-slate-200 bg-slate-50 px-3 py-2.5">
          <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
            Conversion
          </div>
          <div className="mt-1 text-[22px] font-black text-slate-900">
            {pct(totals.converted, totals.created || 1)}%
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-1 items-end gap-4 rounded-[12px] border border-slate-200 bg-[#fafbfd] px-5 pb-3 pt-4">
        {data.map(item => {
          const createdHeight = Math.max((item.created / maxValue) * 126, item.created ? 10 : 2)
          const convertedHeight = Math.max((item.converted / maxValue) * 126, item.converted ? 10 : 2)

          return (
            <div key={item.month} className="flex min-w-0 flex-1 flex-col items-center">
              <div className="flex h-[132px] w-full max-w-[150px] items-end justify-center gap-2">
                <button
                  type="button"
                  title={`${formatMonth(item.month)}: ${item.created} created`}
                  onClick={() => onCreatedClick?.(item.month)}
                  className="group relative flex h-full w-[42%] items-end justify-center"
                >
                  <span
                    className="w-full rounded-t-[5px] bg-[#244a73] transition group-hover:bg-[#1d3d5f]"
                    style={{ height: `${createdHeight}px` }}
                  />
                  <span className="pointer-events-none absolute -top-5 hidden rounded bg-slate-900 px-1.5 py-0.5 text-[8px] font-bold text-white group-hover:block">
                    {item.created}
                  </span>
                </button>

                <button
                  type="button"
                  title={`${formatMonth(item.month)}: ${item.converted} converted`}
                  onClick={() => onConvertedClick?.(item.month)}
                  className="group relative flex h-full w-[42%] items-end justify-center"
                >
                  <span
                    className="w-full rounded-t-[5px] bg-[#2f7d71] transition group-hover:bg-[#276a60]"
                    style={{ height: `${convertedHeight}px` }}
                  />
                  <span className="pointer-events-none absolute -top-5 hidden rounded bg-slate-900 px-1.5 py-0.5 text-[8px] font-bold text-white group-hover:block">
                    {item.converted}
                  </span>
                </button>
              </div>

              <div className="mt-2 text-center text-[10px] font-bold text-slate-600">
                {formatMonth(item.month)}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[9.5px]">
        <div className="flex items-center gap-3 text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px] bg-[#244a73]" />
            Created
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px] bg-[#2f7d71]" />
            Converted
          </span>
        </div>

        <div className="font-semibold text-slate-500">
          Best conversion:{' '}
          <span className="text-slate-900">
            {bestMonth ? formatMonth(bestMonth.month) : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

function QuotationConversionFlow({
  total,
  withQuote,
  withoutQuote,
  accepted,
  onItemClick,
}: {
  total: number
  withQuote: number
  withoutQuote: number
  accepted: number
  onItemClick?: (label: 'Quoted' | 'Without quote' | 'Accepted') => void
}) {
  const { label: opportunityLabel, singularLower: opportunitySingularLower } = useModuleName('opportunities')
  const quotedCoverage = pct(withQuote, total || 1)
  const withoutQuoteCoverage = pct(withoutQuote, total || 1)
  const acceptanceRate = pct(accepted, withQuote || 1)

  const tracks = [
    {
      label: 'Quoted coverage',
      value: withQuote,
      denominator: total,
      percentage: quotedCoverage,
      color: 'bg-[#244a73]',
      text: 'text-[#244a73]',
      bg: 'bg-indigo-50',
      action: 'Quoted' as const,
    },
    {
      label: 'Without quotation',
      value: withoutQuote,
      denominator: total,
      percentage: withoutQuoteCoverage,
      color: 'bg-amber-500',
      text: 'text-amber-700',
      bg: 'bg-amber-50',
      action: 'Without quote' as const,
    },
    {
      label: 'Quote acceptance',
      value: accepted,
      denominator: withQuote,
      percentage: acceptanceRate,
      color: 'bg-[#2f7d71]',
      text: 'text-[#2f7d71]',
      bg: 'bg-emerald-50',
      action: 'Accepted' as const,
    },
  ]

  return (
    <div className="flex min-h-[240px] flex-col">
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2">
        <button
          type="button"
          onClick={() => onItemClick?.('Quoted')}
          className="rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-3 text-left transition hover:border-slate-300 hover:bg-slate-100"
        >
          <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
            Total {opportunityLabel}
          </div>
          <div className="mt-1 text-[24px] font-black text-slate-950">{fmtN(total)}</div>
          <div className="mt-1 text-[9.5px] text-slate-500">Starting {opportunitySingularLower} base</div>
        </button>

        <div className="text-lg font-black text-slate-300">→</div>

        <button
          type="button"
          onClick={() => onItemClick?.('Quoted')}
          className="rounded-[12px] border border-[#d8e1ea] bg-[#f4f7fa] px-3 py-3 text-left transition hover:brightness-[0.98]"
        >
          <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-[#5f7183]">
            Quoted
          </div>
          <div className="mt-1 text-[24px] font-black text-[#244a73]">{fmtN(withQuote)}</div>
          <div className="mt-1 text-[9.5px] font-semibold text-[#244a73]">
            {quotedCoverage}% coverage
          </div>
        </button>

        <div className="text-lg font-black text-slate-300">→</div>

        <button
          type="button"
          onClick={() => onItemClick?.('Accepted')}
          className="rounded-[12px] border border-[#d7e5e1] bg-[#f2f7f6] px-3 py-3 text-left transition hover:brightness-[0.98]"
        >
          <div className="text-[9px] font-extrabold uppercase tracking-[0.06em] text-[#5d756f]">
            Accepted
          </div>
          <div className="mt-1 text-[24px] font-black text-[#2f7d71]">{fmtN(accepted)}</div>
          <div className="mt-1 text-[9.5px] font-semibold text-[#2f7d71]">
            {acceptanceRate}% of quoted
          </div>
        </button>
      </div>

      <div className="mt-4 flex-1 space-y-3 rounded-[12px] border border-slate-200 bg-white p-3">
        {tracks.map(item => (
          <button
            key={item.label}
            type="button"
            onClick={() => onItemClick?.(item.action)}
            className={`block w-full rounded-[10px] px-3 py-2.5 text-left transition hover:brightness-[0.98] ${item.bg}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-[10px] font-bold text-slate-700">{item.label}</div>
              <div className={`text-[11px] font-black ${item.text}`}>
                {fmtN(item.value)} / {fmtN(item.denominator || 0)}
              </div>
            </div>

            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
              <div
                className={`h-full rounded-full ${item.color}`}
                style={{ width: `${Math.min(item.percentage, 100)}%` }}
              />
            </div>

            <div className="mt-1 text-right text-[9px] font-bold text-slate-500">
              {item.percentage}%
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function AgeBands({
  rows,
  onBandClick,
}: {
  rows: any[]
  onBandClick?: (label: string, matchedRows: any[]) => void
}) {
  const bands = [
    {
      label: '0–15 days',
      rows: rows.filter(r => num(r.age_days) <= 15),
      bg: 'bg-[#2f7d71]',
      soft: 'bg-emerald-50',
      text: 'text-[#2f7d71]',
    },
    {
      label: '16–30 days',
      rows: rows.filter(r => num(r.age_days) > 15 && num(r.age_days) <= 30),
      bg: 'bg-sky-500',
      soft: 'bg-sky-50',
      text: 'text-sky-700',
    },
    {
      label: '31–45 days',
      rows: rows.filter(r => num(r.age_days) > 30 && num(r.age_days) <= 45),
      bg: 'bg-amber-500',
      soft: 'bg-amber-50',
      text: 'text-amber-700',
    },
    {
      label: '46+ days',
      rows: rows.filter(r => num(r.age_days) > 45),
      bg: 'bg-rose-500',
      soft: 'bg-rose-50',
      text: 'text-rose-700',
    },
  ]

  const max = Math.max(...bands.map(item => item.rows.length), 1)

  return (
    <div className="space-y-3">
      {bands.map(item => (
        <div
          key={item.label}
          onClick={onBandClick ? () => onBandClick(item.label, item.rows) : undefined}
          className={`rounded-[11px] border border-slate-200 p-3 ${item.soft} ${
            onBandClick ? 'cursor-pointer transition hover:brightness-[0.98]' : ''
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] font-bold text-slate-700">{item.label}</div>
            <div className={`text-[17px] font-black ${item.text}`}>{fmtN(item.rows.length)}</div>
          </div>

          <div className="mt-2 grid grid-cols-12 gap-1">
            {Array.from({ length: 12 }).map((_, index) => {
              const active = index < Math.ceil((item.rows.length / max) * 12)

              return (
                <div
                  key={index}
                  className={`h-2 rounded-[2px] ${active ? item.bg : 'bg-white/80'}`}
                />
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function RecoveryBoard({
  stalled,
  overdue,
  atRisk,
  revenueAtRisk,
  totalOpen,
  onExposureClick,
  onWorkloadClick,
  onStalledClick,
  onOverdueClick,
}: {
  stalled: number
  overdue: number
  atRisk: number
  revenueAtRisk: number
  totalOpen: number
  onExposureClick?: () => void
  onWorkloadClick?: () => void
  onStalledClick?: () => void
  onOverdueClick?: () => void
}) {
  const { labelLower: opportunityLabelLower } = useModuleName('opportunities')
  const recoveryShare = pct(atRisk, totalOpen || 1)
  const stalledShare = pct(stalled, atRisk || 1)
  const overdueShare = pct(overdue, atRisk || 1)

  return (
    <div className="flex h-full min-h-[286px] flex-col overflow-hidden rounded-[13px] bg-[#102d4d] text-white">
      <button
        type="button"
        onClick={onExposureClick}
        className="group relative flex min-h-[132px] w-full flex-col justify-between overflow-hidden px-5 py-5 text-left transition hover:bg-white/[0.035]"
      >
        <div className="absolute -right-10 -top-16 h-44 w-44 rounded-full border-[28px] border-white/[0.045]" />
        <div className="absolute -bottom-20 right-16 h-36 w-36 rounded-full border-[22px] border-white/[0.035]" />

        <div className="relative z-10 flex items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.12em] text-white/60">
              Revenue requiring recovery
            </div>
            <div className="mt-2 text-[34px] font-black leading-none tracking-tight">
              {fmtRsL(revenueAtRisk)}
            </div>
          </div>

          <div className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-[10px] font-extrabold text-white/85">
            {recoveryShare}% of open pipeline
          </div>
        </div>

        <div className="relative z-10 mt-4 flex items-end justify-between gap-4">
          <div className="max-w-[320px] text-[10.5px] leading-4 text-white/60">
            Combined value of {opportunityLabelLower} stalled beyond the target age or carrying an overdue follow-up.
          </div>
          <div className="text-[10px] font-extrabold text-white/75 transition group-hover:translate-x-0.5">
            View exposure →
          </div>
        </div>
      </button>

      <div className="grid flex-1 grid-cols-1 border-t border-white/10 sm:grid-cols-[0.8fr_1.2fr]">
        <button
          type="button"
          onClick={onWorkloadClick}
          className="flex min-h-[132px] flex-col justify-center border-b border-white/10 px-5 py-4 text-left transition hover:bg-white/[0.035] sm:border-b-0 sm:border-r"
        >
          <div className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-white/50">
            Recovery workload
          </div>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-[32px] font-black leading-none">{fmtN(atRisk)}</span>
            <span className="pb-0.5 text-[10px] font-semibold text-white/55">{opportunityLabelLower}</span>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-[#70b9ad]"
              style={{ width: `${Math.min(recoveryShare, 100)}%` }}
            />
          </div>
          <div className="mt-2 text-[9.5px] text-white/45">
            {fmtN(totalOpen)} total open {opportunityLabelLower}
          </div>
        </button>

        <div className="divide-y divide-white/10">
          <button
            type="button"
            onClick={onStalledClick}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-4 text-left transition hover:bg-white/[0.035]"
          >
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold text-white/90">Stalled beyond 45 days</div>
              <div className="mt-1 text-[9.5px] text-white/45">Age-based intervention queue</div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[#ef7181]"
                  style={{ width: `${Math.min(stalledShare, 100)}%` }}
                />
              </div>
            </div>
            <div className="text-right">
              <div className="text-[24px] font-black leading-none text-[#ff9aa6]">{fmtN(stalled)}</div>
              <div className="mt-1 text-[9px] font-bold text-white/40">{stalledShare}% of risk</div>
            </div>
          </button>

          <button
            type="button"
            onClick={onOverdueClick}
            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-4 text-left transition hover:bg-white/[0.035]"
          >
            <div className="min-w-0">
              <div className="text-[11px] font-extrabold text-white/90">Follow-up overdue</div>
              <div className="mt-1 text-[9.5px] text-white/45">Immediate owner action required</div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-[#f2bd63]"
                  style={{ width: `${Math.min(overdueShare, 100)}%` }}
                />
              </div>
            </div>
            <div className="text-right">
              <div className="text-[24px] font-black leading-none text-[#ffd184]">{fmtN(overdue)}</div>
              <div className="mt-1 text-[9px] font-bold text-white/40">{overdueShare}% of risk</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

export default function OpportunitiesReportView() {
  const {
    label: opportunityLabel,
    singular: opportunitySingular,
    labelLower: opportunityLabelLower,
    singularLower: opportunitySingularLower,
  } = useModuleName('opportunities')
  const { singular: customerSingular } = useModuleName('customers')
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
      const res = await api.get(`/reports/opportunities?${toBackendParams(f)}`)
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
      .get('/reports/opportunities/filter-options')
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

  const regions = useMemo(
    () =>
      Array.from(
        new Set(rows.map(r => r.region).filter(Boolean)),
      ).sort() as string[],
    [rows],
  )

  const openRows = useMemo(
    () => tableRows.filter(r => OPEN_STAGES.includes(r.stage)),
    [tableRows],
  )

  const converted = useMemo(
    () => tableRows.filter(r => r.stage === 'Converted'),
    [tableRows],
  )

  const pipelineValue = useMemo(
    () => openRows.reduce((sum, row) => sum + num(row.est_value), 0),
    [openRows],
  )

  const conversionRate = pct(converted.length, tableRows.length || 1)

  const stalled = useMemo(
    () => openRows.filter(r => num(r.age_days) > 45),
    [openRows],
  )

  const overdueFollowup = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)

    return openRows.filter(
      r =>
        r.follow_up &&
        String(r.follow_up).slice(0, 10) < today,
    )
  }, [openRows])

  const atRiskRows = useMemo(() => {
    const seen = new Set<any>()

    return [...stalled, ...overdueFollowup].filter(row => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
  }, [stalled, overdueFollowup])

  const revenueAtRisk = useMemo(
    () =>
      atRiskRows.reduce(
        (sum, row) => sum + num(row.est_value),
        0,
      ),
    [atRiskRows],
  )

  const avgAge = openRows.length
    ? Math.round(
        openRows.reduce(
          (sum, row) => sum + num(row.age_days),
          0,
        ) / openRows.length,
      )
    : 0

  const monthlyTrendRows = useMemo(() => {
    const grouped: Record<
      string,
      { createdRows: any[]; convertedRows: any[] }
    > = {}

    tableRows.forEach(row => {
      const month = String(row.created_at || '').slice(0, 7)

      if (!month) return

      if (!grouped[month]) {
        grouped[month] = {
          createdRows: [],
          convertedRows: [],
        }
      }

      grouped[month].createdRows.push(row)

      if (row.stage === 'Converted') {
        grouped[month].convertedRows.push(row)
      }
    })

    return grouped
  }, [tableRows])

  const monthlyTrend = useMemo(() => {
    const availableMonths = Object.keys(monthlyTrendRows).sort()
    const latestAvailableMonth = availableMonths[availableMonths.length - 1]

    const anchorDate = latestAvailableMonth
      ? new Date(`${latestAvailableMonth}-01T00:00:00`)
      : new Date()

    return Array.from({ length: 3 }, (_, index) => {
      const date = new Date(
        anchorDate.getFullYear(),
        anchorDate.getMonth() - (2 - index),
        1,
      )

      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const values = monthlyTrendRows[month]

      return {
        month,
        created: values?.createdRows.length || 0,
        converted: values?.convertedRows.length || 0,
      }
    })
  }, [monthlyTrendRows])

  const stageRowsMap = useMemo(
    () =>
      Object.fromEntries(
        STAGE_ORDER.map(stage => [
          stage,
          tableRows.filter(row => row.stage === stage),
        ]),
      ) as Record<string, any[]>,
    [tableRows],
  )

  const stageDisplayName = (stage: string) => (stage === 'Opportunity' ? opportunitySingular : stage)

  const stageData = useMemo(
    () =>
      STAGE_ORDER.map(stage => ({
        key: stage,
        name: stageDisplayName(stage),
        value: (stageRowsMap[stage] || []).length,
      })),
    [stageRowsMap, opportunitySingular],
  )

  const withQuote = useMemo(
    () => tableRows.filter(r => num(r.quotation_count) > 0),
    [tableRows],
  )

  const withoutQuoteRows = useMemo(
    () => tableRows.filter(r => !(num(r.quotation_count) > 0)),
    [tableRows],
  )

  const withAccepted = useMemo(
    () => tableRows.filter(r => num(r.accepted_quotes) > 0),
    [tableRows],
  )


  const actionList = useMemo(
    () =>
      [...atRiskRows]
        .sort(
          (a, b) =>
            num(b.est_value) - num(a.est_value),
        )
        .slice(0, 5),
    [atRiskRows],
  )

  const overdueIds = useMemo(
    () => new Set(overdueFollowup.map(r => r.id)),
    [overdueFollowup],
  )

  const cols: ColDef[] = [
    {
      key: 'opportunity_ref_id',
      label: 'Ref ID',
      render: value => (
        <span className="font-mono text-[10px] text-slate-500">
          {value || '—'}
        </span>
      ),
    },
    {
      key: 'lead_title',
      label: 'Title',
      render: value => (
        <span className="block max-w-[220px] truncate font-semibold text-slate-900">
          {value || '—'}
        </span>
      ),
    },
    {
      key: 'customer_name',
      label: customerSingular,
    },
    {
      key: 'stage',
      label: 'Stage',
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
      label: 'Est. Value ₹',
      money: true,
      align: 'right',
    },
    {
      key: 'quotation_count',
      label: 'Quotes',
      align: 'right',
    },
    {
      key: 'region',
      label: 'Region',
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
    {
      key: 'age_days',
      label: 'Age (d)',
      align: 'right',
    },
  ]

  const openRow = (row: any) => {
    setDrilldown({
      entity: 'lead',
      id: row.id,
      label: row.lead_title,
      seedRow: {
        ...row,
        title: row.lead_title,
        customer: row.customer_name,
      },
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
        onExport={() =>
          exportRows(tableRows, cols, 'opportunities')
        }
        filterOptions={{
          owners: options?.users,
          regions,
          statuses: options?.stages,
          customers: options?.customers,
        }}
        loading={loading}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard
          label="Pipeline Value"
          value={fmtRsL(pipelineValue)}
          sub={`${fmtN(openRows.length)} open ${opportunityLabelLower}`}
          accent="indigo"
          icon="pipeline"
          onClick={() =>
            openList('Pipeline Value', `Open ${opportunityLabelLower} contributing to pipeline value`, openRows)
          }
        />

        <MetricCard
          label="Conversion Rate"
          value={`${conversionRate}%`}
          sub={`${fmtN(converted.length)} converted`}
          accent="emerald"
          icon="conversion"
          onClick={() =>
            openList('Conversion Rate', `${opportunityLabel} converted`, converted)
          }
        />

        <MetricCard
          label="Revenue At Risk"
          value={fmtRsL(revenueAtRisk)}
          sub={`${fmtN(atRiskRows.length)} ${opportunityLabelLower} exposed`}
          accent="rose"
          icon="risk"
          onClick={() =>
            openList('Revenue At Risk', `${opportunityLabel} exposed to stalled or overdue risk`, atRiskRows)
          }
        />

        <MetricCard
          label="Average Deal Age"
          value={`${avgAge}d`}
          sub={`Across open ${opportunityLabelLower}`}
          accent="sky"
          icon="age"
          onClick={() =>
            openList('Average Deal Age', `Open ${opportunityLabelLower} used to compute average age`, openRows)
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[0.95fr_1.35fr]">
        <Panel
          title={`${opportunitySingular} Stage Journey`}
          sub="A sequential stage view without funnel or triangle charts"
          icon="pipeline"
        >
          <StageJourney
            stages={stageData}
            total={tableRows.length}
            onStageClick={stage =>
              openList(
                stage.name,
                `${opportunityLabel} currently in this stage`,
                stageRowsMap[stage.key] || [],
              )
            }
          />
        </Panel>

        <Panel
          title={`Monthly ${opportunitySingular} Pulse`}
          sub={`Created versus converted ${opportunityLabelLower} for the latest three months`}
          icon="month"
        >
          <MonthlyOpportunityPulse
            data={monthlyTrend}
            onCreatedClick={month =>
              openList(
                `${month} — Created`,
                `${opportunityLabel} created in this month`,
                monthlyTrendRows[month]?.createdRows || [],
              )
            }
            onConvertedClick={month =>
              openList(
                `${month} — Converted`,
                `${opportunityLabel} created this month that converted`,
                monthlyTrendRows[month]?.convertedRows || [],
              )
            }
          />
        </Panel>
      </div>


      <Panel
        title="Quotation Conversion Flow"
        sub={`${opportunitySingular}-to-quotation coverage and quote acceptance`}
        icon="quote"
      >
        <QuotationConversionFlow
          total={tableRows.length}
          withQuote={withQuote.length}
          withoutQuote={withoutQuoteRows.length}
          accepted={withAccepted.length}
          onItemClick={label => {
            if (label === 'Quoted') {
              openList('Quoted', `${opportunityLabel} with at least one quotation`, withQuote)
            } else if (label === 'Without quote') {
              openList('Without Quote', `${opportunityLabel} with no quotation yet`, withoutQuoteRows)
            } else if (label === 'Accepted') {
              openList('Accepted', `${opportunityLabel} with an accepted quotation`, withAccepted)
            }
          }}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[0.8fr_1.1fr_1.1fr]">
        <Panel
          title="Deal Age Distribution"
          sub={`Open ${opportunityLabelLower} grouped into actionable age bands`}
          icon="age"
        >
          <AgeBands
            rows={openRows}
            onBandClick={(label, matchedRows) =>
              openList(label, `Open ${opportunityLabelLower} in this age band`, matchedRows)
            }
          />
        </Panel>

        <Panel
          className="h-full"
          title="Revenue Recovery Command Centre"
          sub="Prioritised exposure and intervention workload without nested card boxes"
          icon="risk"
        >
          <RecoveryBoard
            stalled={stalled.length}
            overdue={overdueFollowup.length}
            atRisk={atRiskRows.length}
            revenueAtRisk={revenueAtRisk}
            totalOpen={openRows.length}
            onExposureClick={() =>
              openList('Revenue Exposure', `Value connected to stalled or overdue ${opportunityLabelLower}`, atRiskRows)
            }
            onWorkloadClick={() =>
              openList('Recovery Workload', `Unique ${opportunityLabelLower} requiring intervention`, atRiskRows)
            }
            onStalledClick={() =>
              openList('Stalled Beyond 45 Days', `Open ${opportunityLabelLower} stalled beyond 45 days`, stalled)
            }
            onOverdueClick={() =>
              openList('Follow-up Overdue', `Open ${opportunityLabelLower} with an overdue follow-up`, overdueFollowup)
            }
          />
        </Panel>

        <Panel
          title="Manager Action Queue"
          sub={`Highest-value ${opportunityLabelLower} requiring intervention`}
          icon="action"
        >
          <div className="space-y-2">
            {actionList.map((row, index) => {
              const severity =
                num(row.age_days) > 60
                  ? {
                      label: 'Escalate',
                      text: 'text-rose-600',
                      bg: 'bg-rose-50',
                    }
                  : overdueIds.has(row.id)
                    ? {
                        label: 'Call today',
                        text: 'text-amber-600',
                        bg: 'bg-amber-50',
                      }
                    : {
                        label: 'Review',
                        text: 'text-[#244a73]',
                        bg: 'bg-indigo-50',
                      }

              return (
                <button
                  key={row.id || index}
                  type="button"
                  onClick={() => openRow(row)}
                  className="grid w-full grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3 rounded-[11px] border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-indigo-200 hover:bg-slate-50"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-slate-100 text-[10px] font-black text-slate-500">
                    {String(index + 1).padStart(2, '0')}
                  </div>

                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-extrabold text-slate-900">
                      {row.lead_title || `Untitled ${opportunitySingularLower}`}
                    </div>
                    <div className="mt-1 truncate text-[9.5px] text-slate-500">
                      {fmtRsL(num(row.est_value))} · {num(row.age_days)}d · {row.assigned_to || 'Unassigned'}
                    </div>
                  </div>

                  <div className={`rounded-full px-2 py-1 text-[9.5px] font-extrabold ${severity.bg} ${severity.text}`}>
                    {severity.label}
                  </div>
                </button>
              )
            })}

            {!actionList.length ? (
              <div className="rounded-[11px] border border-dashed border-slate-200 py-10 text-center text-[12px] text-slate-400">
                No {opportunityLabelLower} need intervention
              </div>
            ) : null}
          </div>
        </Panel>
      </div>

      <DistributionSection
        rows={rows}
        config={{ bu: 'lollipop', bv: 'bubble', src: 'donut', seg: 'trend' }}
        module={opportunityLabel}
        getBU={r => r.business_vertical || 'Unclassified'}
        getBV={r => r.business_vertical_group || r.business_vertical || 'Unclassified'}
        getSrc={r => r.source || 'Other'}
        getSeg={r => r.customer_segment || 'Unclassified'}
        getResult={r => r.stage === 'Converted' ? 'Converted' : r.stage || r.status || ''}
        getValue={r => Number(r.est_value || 0)}
        onOpenRows={openList}
      />

      <section className="overflow-hidden rounded-[14px] border border-slate-200 bg-white shadow-[0_3px_14px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-2 border-b border-slate-100 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[13px] font-extrabold text-slate-900">
              {opportunitySingular} Registry
            </div>
            <div className="mt-1 text-[10.5px] text-slate-500">
              Complete {opportunitySingularLower} list — click a row for details
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
            title={opportunityLabelLower}
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