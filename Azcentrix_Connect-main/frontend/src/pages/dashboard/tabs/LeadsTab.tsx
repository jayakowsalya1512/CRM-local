/**
 * LeadsTab.tsx — Lead Pipeline Analytics
 * • FilterBar above KPIs
 * • Drag-and-drop section reordering (localStorage-persisted)
 * • RadialBarChart for priority | CSS bars for status
 * • Professional stage names: Sales Qualified / Opportunity Developing / Prospect Identified
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Target, AlertCircle, TrendingUp, Settings2 } from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, RadialBarChart, RadialBar, Legend, Cell,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, fmtN, fmtRsL, splitRs, num, pct,
  ChartTip, Badge, KpiCard, ChartShell, DataTable, FilterBar,
  Section, ModuleHead, TabSkeleton,
  EMPTY_FILTERS, FilterState, ColDef, AXIS_X, AXIS_Y, CGRID,
} from './_shared'

const stageLabel = (priority?: string) => {
  if (priority === 'High') return 'Sales Qualified'
  if (priority === 'Medium') return 'Opportunity Developing'
  return 'Prospect Identified'
}

const stageTone = (priority?: string) => {
  if (priority === 'High') return 'pos'
  if (priority === 'Medium') return 'warn'
  return 'info'
}

function useSectionDrag(storageKey: string, defaultOrder: string[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed: string[] = JSON.parse(saved)
        const merged = parsed.filter(id => defaultOrder.includes(id))
        defaultOrder.forEach(id => { if (!merged.includes(id)) merged.push(id) })
        return merged
      }
    } catch {}
    return defaultOrder
  })

  const dragSrc = useRef<string | null>(null)

  const onDragStart = useCallback((id: string) => {
    dragSrc.current = id
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const onDrop = useCallback((targetId: string) => {
    const src = dragSrc.current
    if (!src || src === targetId) return

    setOrder(prev => {
      const next = [...prev]
      const si = next.indexOf(src)
      const ti = next.indexOf(targetId)

      next.splice(si, 1)
      next.splice(ti, 0, src)

      try {
        localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {}

      return next
    })

    dragSrc.current = null
  }, [storageKey])

  return { order, onDragStart, onDragOver, onDrop }
}

function DragSection({
  id,
  arranging,
  onDragStart,
  onDragOver,
  onDrop,
  children,
}: {
  id: string
  arranging: boolean
  onDragStart: (id: string) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div
      draggable={arranging}
      onDragStart={() => onDragStart(id)}
      onDragOver={onDragOver}
      onDrop={() => onDrop(id)}
      className={`relative ${arranging ? 'cursor-grab active:cursor-grabbing' : ''}`}
    >
      {arranging && (
        <div className="absolute inset-0 z-0 rounded-2xl border-2 border-dashed border-sky-200 bg-sky-50/20 pointer-events-none" />
      )}
      <div className="relative z-0">{children}</div>
    </div>
  )
}

function RegionHealthChart({ rows }: { rows: any[] }) {
  const data = useMemo(() => {
    const m: Record<string, { active: number; converted: number; lost: number; value: number }> = {}
    rows.forEach(r => {
      const key = (r.region || r.branch || r.state || '').trim()
      if (!key) return
      if (!m[key]) m[key] = { active: 0, converted: 0, lost: 0, value: 0 }
      const st = r.status || ''
      if (['Assigned', 'Contacted', 'Qualified', 'Proposal Pending', 'Nurturing', 'Opportunity Created'].includes(st)) m[key].active++
      else if (st === 'Converted') m[key].converted++
      else if (st === 'Lost') m[key].lost++
      m[key].value += num(r.est_value)
    })
    return Object.entries(m)
      .map(([name, v]) => ({ name, ...v, total: v.active + v.converted + v.lost }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 9)
  }, [rows])

  if (!data.length) return (
    <div className="flex h-full items-center justify-center text-xs text-slate-400">No region data</div>
  )

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout="vertical" barSize={11} margin={{ top: 4, right: 16, bottom: 0, left: 72 }}>
        <CartesianGrid {...CGRID} horizontal={false} vertical />
        <XAxis type="number" {...AXIS_X} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
        <YAxis type="category" dataKey="name" {...AXIS_Y} axisLine={false} tickLine={false} width={68} />
        <Tooltip content={<ChartTip />} />
        <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10, paddingBottom: 2 }} />
        <Bar dataKey="active" name="Active" stackId="a" fill="#0284c7" />
        <Bar dataKey="converted" name="Converted" stackId="a" fill="#059669" />
        <Bar dataKey="lost" name="Lost" stackId="a" fill="#ef4444" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function PipelineAgeChart({ rows }: { rows: any[] }) {
  const { label } = useModuleName('leads')
  const data = useMemo(() => {
    const today = new Date()
    const buckets = [
      { name: '≤7d',    min: 0,   max: 7 },
      { name: '8–30d',  min: 8,   max: 30 },
      { name: '31–90d', min: 31,  max: 90 },
      { name: '91–180d',min: 91,  max: 180 },
      { name: '180d+',  min: 181, max: Infinity },
    ]
    const active = rows.filter(r => !['Converted', 'Lost'].includes(r.status || ''))
    const counts = buckets.map(b => ({ name: b.name, count: 0, value: 0, min: b.min, max: b.max }))
    active.forEach(r => {
      if (!r.created_at) return
      const age = Math.floor((today.getTime() - new Date(r.created_at).getTime()) / 86400000)
      const idx = counts.findIndex(b => age >= b.min && age <= b.max)
      if (idx >= 0) { counts[idx].count++; counts[idx].value += num(r.est_value) }
    })
    return counts
  }, [rows])

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} barSize={32} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid {...CGRID} vertical={false} />
        <XAxis dataKey="name" {...AXIS_X} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
        <YAxis {...AXIS_Y} axisLine={false} tickLine={false} width={28} />
        <Tooltip content={<ChartTip />} />
        <Bar dataKey="count" name={`Active ${label}`} radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.min <= 7 ? '#10b981' : d.min <= 30 ? '#0ea5e9' : d.min <= 90 ? '#f59e0b' : d.min <= 180 ? '#f97316' : '#ef4444'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function StatusBars({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1

  const colors: Record<string, string> = {
    New: '#6366f1',
    Active: '#0284c7',
    Qualified: '#8b5cf6',
    'Proposal Sent': '#f59e0b',
    Negotiation: '#10b981',
    Converted: '#059669',
    Lost: '#ef4444',
    'On Hold': '#94a3b8',
  }

  return (
    <div className="space-y-2.5 py-1">
      {data.map(d => (
        <div key={d.name}>
          <div className="flex justify-between text-xs mb-1">
            <span className="font-medium text-slate-700">{d.name}</span>
            <span className="text-slate-500">
              {d.value} ({pct(d.value, total)}%)
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${(d.value / total) * 100}%`,
                background: colors[d.name] || '#6366f1',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

type CompareBy = 'user' | 'group' | 'state' | 'source' | 'sector' | 'month'

const COMPARE_OPTIONS: { value: CompareBy; label: string; short: string }[] = [
  { value: 'user', label: 'User-wise', short: 'User' },
  { value: 'group', label: 'Group-wise', short: 'Group' },
  { value: 'state', label: 'State-wise', short: 'State' },
  { value: 'source', label: 'Source-wise', short: 'Source' },
  { value: 'sector', label: 'Sector-wise', short: 'Sector' },
  { value: 'month', label: 'Month-wise', short: 'Month' },
]

function getDimension(row: any, by: CompareBy): string {
  switch (by) {
    case 'user': return row.assigned_to || 'Unassigned'
    case 'group': return row.group || row.assigned_group || row.team || 'No Group'
    case 'state': return row.state || row.region || 'Unknown'
    case 'source': return row.source || row.lead_source || 'Direct'
    case 'sector': return row.industry || row.vertical || row.sector || 'General'
    case 'month': return (row.created_at || '').slice(0, 7) || 'Unknown'
  }
}

function SegmentSourceLeadsCard({ data }: { data: any[] }) {
  const { label, labelLower } = useModuleName('leads')
  const rows = Array.isArray(data) ? data : []
  const maxV = rows[0]?.value || 1

  const colors = [
    '#6366f1',
    '#8b5cf6',
    '#06b6d4',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#ec4899',
    '#14b8a6',
    '#3b82f6',
    '#84cc16',
  ]

  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl">
      <p className="text-[13px] font-semibold text-slate-900 mb-1">
        Segment-wise Source {label}
      </p>
      <p className="text-[11px] text-slate-500 mb-3">
        {label} count by active customer segment and {labelLower} source
      </p>

      <div className="space-y-3">
        {rows.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-400">
            No segment/source {labelLower} data
          </div>
        ) : rows.map((segment, i) => {
          const sourceList = Array.isArray(segment.sources) ? segment.sources : []

          return (
            <div key={segment.name} className="space-y-1.5">
              <div className="flex items-center gap-3 text-xs">
                <span
                  className="h-3 w-3 flex-shrink-0 rounded-sm"
                  style={{ background: colors[i % colors.length] }}
                />

                <span className="flex-1 truncate font-medium text-slate-700">
                  {segment.name}
                </span>

                <div className="h-2 w-20 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${((segment.value || 0) / maxV) * 100}%`,
                      background: colors[i % colors.length],
                    }}
                  />
                </div>

                <span className="w-8 text-right font-semibold text-slate-700">
                  {segment.value || 0}
                </span>
              </div>

              {sourceList.length > 0 && (
                <div className="ml-6 flex flex-wrap gap-1.5">
                  {sourceList.map((src: any) => (
                    <span
                      key={`${segment.name}-${src.name}`}
                      className="rounded-full border border-sky-100 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700"
                    >
                      {src.name}: {src.value}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LeadComparisonTable({ rows }: { rows: any[] }) {
  const { singular } = useModuleName('leads')
  const [compareBy, setCompareBy] = useState<CompareBy>('group')
  const today = new Date().toISOString().split('T')[0]

  const grouped = useMemo(() => {
    const m: Record<string, {
      total: number
      decision_ready: number
      active_nurture: number
      early_stage: number
      converted: number
      lost: number
      pending_followup: number
      overdue: number
      value: number
    }> = {}

    rows.forEach(r => {
      const key = getDimension(r, compareBy)

      if (!m[key]) {
        m[key] = {
          total: 0,
          decision_ready: 0,
          active_nurture: 0,
          early_stage: 0,
          converted: 0,
          lost: 0,
          pending_followup: 0,
          overdue: 0,
          value: 0,
        }
      }

      m[key].total++

      const priority = (r.priority || '').toLowerCase()

      if (priority === 'high') m[key].decision_ready++
      else if (priority === 'medium') m[key].active_nurture++
      else m[key].early_stage++

      const st = r.status || ''

      if (st === 'Converted') m[key].converted++
      if (st === 'Lost') m[key].lost++

      if (r.follow_up && r.follow_up >= today && !['Converted', 'Lost'].includes(st)) {
        m[key].pending_followup++
      }

      if (r.follow_up && r.follow_up < today && !['Converted', 'Lost'].includes(st)) {
        m[key].overdue++
      }

      m[key].value += num(r.est_value)
    })

    return Object.entries(m)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 25)
  }, [rows, compareBy, today])

  if (!grouped.length) return null

  const headerLabel = COMPARE_OPTIONS.find(o => o.value === compareBy)?.short || 'Entity'

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/60 px-5 py-3.5">
        <div>
          <div className="text-[13px] font-semibold text-slate-900">{singular} Comparison</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            Grouped by{' '}
            <span className="font-semibold text-sky-700">
              {COMPARE_OPTIONS.find(o => o.value === compareBy)?.label}
            </span>{' '}
            · {grouped.length} {headerLabel.toLowerCase()}s
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
            Compare by
          </span>
          {COMPARE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setCompareBy(opt.value)}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition-all ${
                opt.value === compareBy
                  ? 'border-sky-600 bg-sky-600 text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-sky-300 hover:text-sky-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">{headerLabel}</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Total</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Sales Qualified</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-amber-700">Opportunity Developing</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-sky-700">Prospect Identified</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Converted</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-red-600">Lost</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-violet-700">Pipeline ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-slate-600">Avg Value ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-amber-600">Overdue</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Win Rate %</th>
            </tr>
          </thead>

          <tbody>
            {grouped.map(([name, v]) => {
              const winRate = v.total ? (v.converted / v.total) * 100 : 0
              const avgVal = v.total ? v.value / v.total : 0

              return (
                <tr key={name} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-2.5 font-medium text-slate-900">
                    <div className="max-w-[180px] truncate" title={name}>{name}</div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-sky-500 transition-all duration-700"
                        style={{
                          width: `${v.total ? Math.min(100, (v.decision_ready / v.total) * 100 + 20) : 0}%`,
                        }}
                      />
                    </div>
                  </td>

                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">{fmtN(v.total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-emerald-700">{fmtN(v.decision_ready)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">{fmtN(v.active_nurture)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-sky-700">{fmtN(v.early_stage)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-emerald-700">{fmtN(v.converted)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-red-600">{fmtN(v.lost)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-violet-700">{fmtRsL(v.value)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-600">{fmtRsL(avgVal)}</td>

                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {v.overdue > 0 ? (
                      <span className="font-semibold text-amber-700">{fmtN(v.overdue)}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>

                  <td className="px-4 py-2.5 text-right">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold tabular-nums ${
                      winRate >= 30
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : winRate >= 15
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-red-200 bg-red-50 text-red-700'
                    }`}>
                      {winRate.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function OpportunitiesPanel({ rows }: { rows: any[] }) {
  const { label: oppLabel, labelLower: oppLabelLower } = useModuleName('opportunities')
  const opps = useMemo(() =>
    rows
      .filter(r => ['Opportunity Created', 'Qualified', 'Proposal Sent', 'Negotiation'].includes(r.status))
      .sort((a, b) => num(b.est_value) - num(a.est_value))
      .slice(0, 6),
    [rows]
  )

  const totalValue = opps.reduce((sum, r) => sum + num(r.est_value), 0)

  if (!opps.length) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-sky-100 bg-sky-50 py-5 text-sm text-sky-600">
        No active {oppLabelLower} in pipeline
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-sky-200 bg-gradient-to-b from-sky-50/60 to-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between border-b border-sky-200/60 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <TrendingUp size={14} className="text-sky-600" />
          <span className="text-[13px] font-semibold text-sky-900">Active {oppLabel}</span>
          <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-bold text-sky-700">
            {opps.length}
          </span>
        </div>

        <span className="font-semibold text-[13px] text-sky-700 tabular-nums">
          {fmtRsL(totalValue)} pipeline
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
        {opps.map((r, i) => (
          <div key={i} className="rounded-xl border border-sky-100 bg-white px-4 py-3 shadow-sm hover:shadow-md transition-shadow">
            <div className="text-[10px] font-bold uppercase tracking-wider text-sky-600 truncate">
              {r.status}
            </div>

            <div className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug text-slate-900">
              {r.title || r.name}
            </div>

            <div className="mt-0.5 truncate text-[11px] text-slate-500">
              {r.customer}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="font-mono text-[13px] font-bold tabular-nums text-sky-700">
                {fmtRsL(num(r.est_value))}
              </span>

              {r.priority && (
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  r.priority === 'High'
                    ? 'bg-emerald-100 text-emerald-700'
                    : r.priority === 'Medium'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-sky-100 text-sky-700'
                }`}>
                  {stageLabel(r.priority)}
                </span>
              )}
            </div>

            {r.assigned_to && (
              <div className="mt-1 text-[10px] text-slate-400 truncate">
                KAM: {r.assigned_to}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function OverdueList({ rows }: { rows: any[] }) {
  const today = new Date().toISOString().split('T')[0]

  const overdue = useMemo(() =>
    rows
      .filter(r => r.follow_up && r.follow_up < today && !['Converted', 'Lost'].includes(r.status))
      .sort((a, b) => (a.follow_up || '').localeCompare(b.follow_up || ''))
      .slice(0, 10),
    [rows, today]
  )

  if (!overdue.length) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 py-5 text-sm text-emerald-700">
        <span className="font-semibold">All follow-ups are current ✓</span>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-red-200 bg-gradient-to-b from-red-50 to-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="flex items-center gap-2.5 border-b border-red-200/60 px-5 py-3.5">
        <AlertCircle size={14} className="text-red-600" />
        <span className="text-[13px] font-semibold text-red-900">Overdue Follow-ups</span>
        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
          {overdue.length}
        </span>
      </div>

      <div className="divide-y divide-red-100">
        {overdue.map((r, i) => {
          const daysAgo = Math.floor((Date.now() - new Date(r.follow_up).getTime()) / 86400000)

          return (
            <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-5 py-3">
              <div>
                <div className="max-w-[280px] truncate text-[13px] font-medium text-slate-900">
                  {r.title || r.name}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {r.customer} · {r.assigned_to}
                </div>
              </div>

              <Badge text={r.status} />

              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                r.priority === 'High'
                  ? 'bg-emerald-100 text-emerald-700'
                  : r.priority === 'Medium'
                  ? 'bg-amber-100 text-amber-700'
                  : 'bg-sky-100 text-sky-700'
              }`}>
                {stageLabel(r.priority)}
              </span>

              <span className="rounded-full bg-red-100 px-2.5 py-1 font-mono text-[10px] font-bold text-red-700">
                {daysAgo}d overdue
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const LEADS_SECTION_DEFAULTS = [
  's_kpi',
  's_opportunities',
  's_overdue',
  's_charts',
  's_comparison',
  's_top',
  's_table',
]

export default function LeadsTab() {
  const { label, singular, labelLower } = useModuleName('leads')
  const { label: oppLabel } = useModuleName('opportunities')
  const { label: customerLabel, singular: customerSingular } = useModuleName('customers')
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [pendingFilters, setPendingFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [arranging, setArranging] = useState(false)

  const { order, onDragStart, onDragOver, onDrop } = useSectionDrag(
    'crm_leads_sections',
    LEADS_SECTION_DEFAULTS
  )

  const loadData = useCallback(async (f: FilterState) => {
    setLoading(true)

    try {
      const p = new URLSearchParams()

      Object.entries(f).forEach(([k, v]) => {
        if (v) p.set(k, v)
      })

      const res = await api.get(`/dashboard/tab/leads?${p}`)
      setData(res.data)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(EMPTY_FILTERS)
  }, [loadData])

  const handleChange = (k: keyof FilterState, v: string) => {
    setPendingFilters(p => ({ ...p, [k]: v }))
  }

  const handleApply = () => {
    setFilters(pendingFilters)
    loadData(pendingFilters)
  }

  const handleReset = () => {
    setFilters(EMPTY_FILTERS)
    setPendingFilters(EMPTY_FILTERS)
    loadData(EMPTY_FILTERS)
  }

  if (loading && !data) return <TabSkeleton />

  const s = data?.summary || {}
  const c = data?.charts || {}
  const tableRows: any[] = data?.table || []

  const pipeSplit = splitRs(num(s.pipeline_value))

  const cols: ColDef[] = [
    {
      key: 'ref',
      label: 'Ref',
      render: (v: string) => (
        <span className="font-mono text-[10px] text-slate-400">
          {v || '—'}
        </span>
      ),
    },
    {
      key: 'title',
      label: 'Title',
      render: (v: string) => (
        <span className="line-clamp-1 block max-w-[220px] font-semibold text-slate-900">
          {v}
        </span>
      ),
    },
    { key: 'customer', label: customerSingular },
    {
      key: 'status',
      label: 'Status',
      render: (v: string) => v ? <Badge text={v} /> : null,
    },
    {
      key: 'priority',
      label: 'Stage',
      render: (v: string) => {
        if (!v) return null
        return <Badge text={stageLabel(v)} tone={stageTone(v)} />
      },
    },
    { key: 'group', label: 'Group' },
    { key: 'est_value', label: 'Est ₹', money: true, align: 'right' },
    {
      key: 'follow_up',
      label: 'Follow-up',
      render: (v: string, row: any) => {
        if (!v) return <span className="text-slate-400">—</span>

        const today = new Date().toISOString().split('T')[0]
        const overdue = v < today && !['Converted', 'Lost'].includes(row.status)

        return (
          <span className={`inline-flex items-center gap-1 font-mono text-[11px] font-semibold ${
            overdue ? 'text-red-700' : 'text-slate-700'
          }`}>
            {overdue && <AlertCircle size={10} className="flex-shrink-0" />}
            {v}
          </span>
        )
      },
    },
    { key: 'assigned_to', label: 'Assignee' },
    // { key: 'region', label: 'Region' },
    { key: 'created_at', label: 'Created' },
  ]

  const funnelData = [
    { name: 'Total', value: num(s.total), fill: '#4338ca' },
    { name: 'Active', value: num(s.active), fill: '#0284c7' },
    {
      name: 'Qualified',
      value: num(s.qualified || Math.round(num(s.active) * 0.6)),
      fill: '#d97706',
    },
    { name: 'Converted', value: num(s.converted), fill: '#059669' },
  ]

  const priorityData = (c.by_priority || []).map((p: any) => ({
    name: stageLabel(p.name),
    value: p.value,
    fill: p.name === 'High' ? '#10b981' : p.name === 'Medium' ? '#f59e0b' : '#0ea5e9',
  }))

  const sectionMap: Record<string, React.ReactNode> = {


    s_opportunities: (
      <>
        <Section idx="02" title={oppLabel} desc="Sales Qualified / Opportunity Developing / Proposal stage" />
        <OpportunitiesPanel rows={tableRows} />
      </>
    ),

    s_overdue: num(s.overdue) > 0 ? (
      <>
        <Section idx="03" title="Overdue Follow-ups" desc={`${num(s.overdue)} ${labelLower} need immediate action`} />
        <OverdueList rows={tableRows} />
      </>
    ) : null,

    s_charts: (
      <>
        <Section idx="04" title="Distribution & Trends" />

        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.4fr_1fr] gap-4">
          <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl">
            <p className="text-[13px] font-semibold text-slate-900 mb-1">By Status</p>
            <p className="text-[11px] text-slate-500 mb-3">{singular} stage composition</p>
            <StatusBars data={c.by_status || []} />
          </div>

          <ChartShell title="Monthly Trend" sub={`New ${labelLower} — last 12 months`} height={260}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={c.monthly_trend || []} margin={{ top: 8, right: 12, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="ldGr" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.primary} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={C.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...CGRID} />
                <XAxis dataKey="month" {...AXIS_X} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
                <YAxis {...AXIS_Y} axisLine={false} tickLine={false} width={28} />
                <Tooltip content={<ChartTip />} />
                <Area
                  type="monotone"
                  dataKey="value"
                  name={label}
                  stroke={C.primary}
                  strokeWidth={2}
                  fill="url(#ldGr)"
                  dot={{ r: 3, fill: '#fff', stroke: C.primary, strokeWidth: 2 }}
                  activeDot={{ r: 5, fill: C.primary, stroke: '#fff', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartShell>

          <ChartShell title="By Stage" sub="Sales Qualified · Opportunity Developing · Prospect Identified" height={260}>
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                cx="50%"
                cy="55%"
                innerRadius="25%"
                outerRadius="85%"
                data={priorityData}
                startAngle={180}
                endAngle={-180}
              >
                <RadialBar
                  background={{ fill: '#f1f5f9' }}
                  dataKey="value"
                  cornerRadius={4}
                  label={{ position: 'insideStart', fill: '#fff', fontSize: 10, fontWeight: 600 }}
                />
                <Legend
                  iconSize={8}
                  iconType="circle"
                  wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
                  formatter={(v: string) => <span style={{ color: '#475569' }}>{v}</span>}
                />
                <Tooltip content={<ChartTip />} />
              </RadialBarChart>
            </ResponsiveContainer>
          </ChartShell>
        </div>
        <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SegmentSourceLeadsCard data={c.by_segment_source || []} />

      <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl">
        <p className="text-[13px] font-semibold text-slate-900 mb-1">By Source</p>
        <p className="text-[11px] text-slate-500 mb-3">{singular} count by source</p>
        <StatusBars data={c.by_source || []} />
      </div>
    </div>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl">
            <div className="border-b border-slate-200/60 px-5 pt-4 pb-3">
              <div className="text-[13px] font-semibold text-slate-900">Conversion Funnel</div>
              <div className="mt-0.5 text-[11px] text-slate-500">Stage-by-stage progression</div>
            </div>

            <div className="space-y-2.5 px-[18px] pb-4 pt-3">
              {funnelData.map((stage, i) => {
                const pctVal = funnelData[0].value
                  ? Math.round((stage.value / funnelData[0].value) * 100)
                  : 0

                const conv = i > 0 && funnelData[i - 1].value
                  ? Math.round((stage.value / funnelData[i - 1].value) * 100)
                  : 100

                return (
                  <div key={i}>
                    <div className="mb-1.5 flex items-baseline justify-between">
                      <span className="text-[13px] font-semibold text-slate-900">{stage.name}</span>
                      <div className="flex items-baseline gap-2 tabular-nums">
                        <span className="text-[17px] font-bold text-slate-900">{fmtN(stage.value)}</span>
                        {i > 0 && (
                          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">
                            {conv}% conv
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="h-3 overflow-hidden rounded-md bg-slate-100">
                      <div
                        className="h-full rounded-md transition-all duration-700"
                        style={{
                          width: `${Math.max(pctVal, 2)}%`,
                          background: stage.fill,
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <ChartShell title="State Performance" sub="Active · Converted · Lost per region" height={260}>
            <RegionHealthChart rows={tableRows} />
          </ChartShell>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <ChartShell title="Pipeline Freshness" sub={`Active ${labelLower} by days in pipeline`} height={220}>
            <PipelineAgeChart rows={tableRows} />
          </ChartShell>

          <ChartShell title="Business Vertical" sub={`${label} by business vertical`} height={220}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={(c.by_vertical || []).slice(0, 10)}
                layout="vertical"
                barSize={13}
                margin={{ top: 0, right: 16, bottom: 0, left: 80 }}
              >
                <CartesianGrid {...CGRID} horizontal={false} vertical />
                <XAxis type="number" {...AXIS_X} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
                <YAxis type="category" dataKey="name" {...AXIS_Y} axisLine={false} tickLine={false} width={76} />
                <Tooltip content={<ChartTip />} />
                <Bar dataKey="value" name={label} fill="#8b5cf6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartShell>
        </div>
      </>
    ),

    s_comparison: (
      <>
        <Section idx="06" title={`${singular} Comparison`} desc="Compare by User · Group · State · Source · Sector · Month" />
        <LeadComparisonTable rows={tableRows} />
      </>
    ),

    s_top: (() => {
      const topLeads = [...tableRows]
        .filter(r => num(r.est_value) > 0)
        .sort((a, b) => num(b.est_value) - num(a.est_value))
        .slice(0, 10)

      const custMap: Record<string, { count: number; value: number }> = {}

      tableRows.forEach(r => {
        const cust = r.customer || r.customer_name || r.company || 'Unknown'

        if (!custMap[cust]) {
          custMap[cust] = { count: 0, value: 0 }
        }

        custMap[cust].count++
        custMap[cust].value += num(r.est_value)
      })

      const topCust = Object.entries(custMap)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)

      const maxLeadCount = topCust[0]?.[1].count || 1
      const maxLeadVal = topLeads[0] ? num(topLeads[0].est_value) : 1

      return (
        <>
          <Section idx="07" title={`Top ${label}`} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl">
              <div className="border-b border-slate-200/60 px-5 pt-4 pb-3">
                <div className="text-[13px] font-semibold text-slate-900">Top 10 — Highest Value {label}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">Ranked by estimated deal value</div>
              </div>

              <div className="divide-y divide-slate-100">
                {topLeads.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-8">No {labelLower} value data</p>
                ) : (
                  topLeads.map((r, i) => {
                    const stage = stageLabel(r.priority)
                    const stageColor =
                      r.priority === 'High'
                        ? '#10b981'
                        : r.priority === 'Medium'
                        ? '#f59e0b'
                        : '#0ea5e9'

                    return (
                      <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                        <span className={`flex-shrink-0 w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center ${
                          i < 3 ? 'bg-sky-600 text-white' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {i + 1}
                        </span>

                        <div className="flex-1 min-w-0">
                          <div className="text-[12px] font-semibold text-slate-800 truncate">
                            {r.title || r.name || '—'}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {r.customer || '—'} · <span style={{ color: stageColor }}>{stage}</span>
                          </div>
                        </div>

                        <span className="text-[12px] font-bold text-sky-700 tabular-nums flex-shrink-0">
                          {fmtRsL(num(r.est_value))}
                        </span>

                        <div className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden flex-shrink-0">
                          <div
                            className="h-full rounded-full bg-sky-500"
                            style={{
                              width: `${(num(r.est_value) / maxLeadVal) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl">
              <div className="border-b border-slate-200/60 px-5 pt-4 pb-3">
                <div className="text-[13px] font-semibold text-slate-900">Top 10 — Most Active {customerLabel}</div>
                <div className="mt-0.5 text-[11px] text-slate-500">{customerLabel} with the highest {labelLower} count</div>
              </div>

              <div className="divide-y divide-slate-100">
                {topCust.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-8">No {customerSingular.toLowerCase()} data</p>
                ) : (
                  topCust.map(([name, v], i) => (
                    <div key={name} className="flex items-center gap-3 px-4 py-2.5">
                      <span className={`flex-shrink-0 w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center ${
                        i < 3 ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {i + 1}
                      </span>

                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-semibold text-slate-800 truncate">{name}</div>
                        <div className="text-[10px] text-slate-400">{fmtRsL(v.value)} pipeline value</div>
                      </div>

                      <span className="text-[12px] font-bold text-emerald-700 tabular-nums flex-shrink-0">
                        {v.count} {labelLower}
                      </span>

                      <div className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden flex-shrink-0">
                        <div
                          className="h-full rounded-full bg-emerald-500"
                          style={{
                            width: `${(v.count / maxLeadCount) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )
    })(),

    s_table: (
      <>
        <Section idx="08" title={`All ${label}`} />
        <DataTable rows={tableRows} columns={cols} title={labelLower} />
      </>
    ),
  }

  return (
    <div className="space-y-5 p-6">
      <div className="relative overflow-hidden rounded-[30px] border border-slate-800 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-6 shadow-2xl">
        <div className="absolute -right-16 -top-16 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
        <div className="absolute -bottom-20 -left-16 h-72 w-72 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />

        <div className="relative z-10 flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-cyan-200">
              <Target size={13} />
              Sales Pipeline Intelligence
            </div>

            <h1 className="mt-4 text-3xl font-black tracking-tight text-white">
              {singular} Analytics
            </h1>

            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-300">
              Track {labelLower} quality, active pipeline, conversions, overdue follow-ups and estimated business value from one executive view.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => loadData(filters)}
              disabled={loading}
              className="rounded-xl border border-white/10 bg-white/10 px-4 py-2 text-xs font-semibold text-white backdrop-blur transition-all hover:bg-white/20 disabled:opacity-60"
            >
              {loading ? 'Refreshing...' : 'Refresh Analytics'}
            </button>

            <button
              onClick={() => setArranging(a => !a)}
              className={`flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-semibold backdrop-blur transition-all ${
                arranging
                  ? 'border-cyan-300/40 bg-cyan-300/20 text-cyan-100'
                  : 'border-white/10 bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              <Settings2 size={13} />
              {arranging ? 'Done' : 'Arrange'}
            </button>
          </div>
        </div>

        <div className="relative z-10 mt-7 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[
            { label: `Total ${label}`, value: fmtN(num(s.total)), sub: `Overall ${labelLower} volume`, tone: 'text-white' },
            { label: 'Active', value: fmtN(num(s.active)), sub: 'Currently in pipeline', tone: 'text-cyan-200' },
            { label: 'Converted', value: fmtN(num(s.converted)), sub: 'Successfully won', tone: 'text-emerald-200' },
            { label: 'Pipeline Value', value: `${pipeSplit.val}${pipeSplit.unit ? ` ${pipeSplit.unit}` : ''}`, sub: 'Estimated business value', tone: 'text-violet-200' },
          ].map(item => (
            <div key={item.label} className="rounded-2xl border border-white/10 bg-white/[0.07] p-4 backdrop-blur">
              <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                {item.label}
              </div>
              <div className={`mt-2 text-2xl font-black tabular-nums ${item.tone}`}>
                {item.value}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                {item.sub}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-[24px] border border-slate-200 bg-white/90 p-4 shadow-sm backdrop-blur">
        <FilterBar
          filters={pendingFilters}
          onChange={handleChange}
          onApply={handleApply}
          onReset={handleReset}
          filterOptions={data?.filters || {}}
          loading={loading}
        />
      </div>
      {order.map(id => {
        const content = sectionMap[id]
        if (!content) return null

        return (
          <DragSection
            key={id}
            id={id}
            arranging={arranging}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
          >
            <div className="space-y-3">{content}</div>
          </DragSection>
        )
      })}
    </div>
  )
}