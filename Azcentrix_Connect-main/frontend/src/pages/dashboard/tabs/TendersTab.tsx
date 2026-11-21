/**
 * TendersTab.tsx — Premium Tender Analytics Dashboard
 * Features:
 * 1. Hero KPI strip — 6 primary + 6 secondary cards with sparkline indicators
 * 2. Smart Alert banner — submission deadlines, EMD gaps, won-without-PO
 * 3. Stage pipeline funnel with conversion % between stages
 * 4. Portal performance comparison table
 * 5. Monthly trend (ComposedChart: count bars + won value line)
 * 6. Upcoming bid calendar with urgency heat mapping
 * 7. Top tenders by value, top customers, top KAMs
 * 8. Full filterable data table
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle, AlertTriangle, ArrowDown, ArrowRight, ArrowUp,
  Award, BarChart2, Bell, Briefcase, Calendar, CheckCircle2,
  ChevronLeft, ChevronRight, Clock, FileText, Filter, RefreshCw,
  Search, Settings2, Shield, TrendingUp, Users, X, Zap, XCircle, Info,
} from 'lucide-react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart,
  Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, CHART, fmtN, fmtRsL, splitRs, num, pct,
  ChartTip, Badge, KpiCard, ChartShell, TopList, DataTable,
  FilterBar, Section, ModuleHead, TabSkeleton, ComparisonPanel,
  EMPTY_FILTERS, FilterState, ColDef, AXIS_X, AXIS_Y, CGRID,
} from './_shared'

/* ─────────────────────────────────────────────────────────────────
   DRAG-AND-DROP SECTION ORDERING
───────────────────────────────────────────────────────────────── */
function useSectionDrag(storageKey: string, defaultOrder: string[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed: string[] = JSON.parse(saved)
        const merged = parsed.filter((id) => defaultOrder.includes(id))
        defaultOrder.forEach((id) => { if (!merged.includes(id)) merged.push(id) })
        return merged
      }
    } catch { /* ignore */ }
    return defaultOrder
  })
  const dragSrc = useRef<string | null>(null)
  const onDragStart = useCallback((id: string) => { dragSrc.current = id }, [])
  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault() }, [])
  const onDrop      = useCallback((targetId: string) => {
    const src = dragSrc.current
    if (!src || src === targetId) return
    setOrder((prev) => {
      const next = [...prev]
      const si = next.indexOf(src), ti = next.indexOf(targetId)
      next.splice(si, 1); next.splice(ti, 0, src)
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    dragSrc.current = null
  }, [storageKey])
  return { order, onDragStart, onDragOver, onDrop }
}

function DragSection({
  id, arranging, onDragStart, onDragOver, onDrop, children,
}: {
  id: string; arranging: boolean
  onDragStart: (id: string) => void
  onDragOver:  (e: React.DragEvent) => void
  onDrop:      (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div
      draggable={arranging}
      onDragStart={() => onDragStart(id)}
      onDragOver={onDragOver}
      onDrop={() => onDrop(id)}
      className={`relative ${arranging ? 'cursor-grab active:cursor-grabbing ring-2 ring-indigo-200 ring-offset-1 rounded-2xl' : ''}`}
    >
      {arranging && (
        <div className="pointer-events-none absolute inset-0 z-10 rounded-2xl bg-indigo-50/30" />
      )}
      <div className="space-y-3">{children}</div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   DESIGN TOKENS
───────────────────────────────────────────────────────────────── */
const T = {
  primary:   '#1e40af',
  primary2:  '#3b82f6',
  pos:       '#059669',
  neg:       '#dc2626',
  warn:      '#d97706',
  info:      '#0284c7',
  violet:    '#7c3aed',
  orange:    '#ea580c',
  teal:      '#0d9488',
  slate:     '#64748b',
  ink:       '#0f172a',
  border:    '#e2e8f0',
  surface:   '#f8fafc',
} as const

const STAGE_COLORS: Record<string, string> = {
  'Aligned':         '#6366f1',
  'Evaluation':      '#8b5cf6',
  'Pre-Bid':         '#0284c7',
  'Submitted':       '#0d9488',
  'Reverse Auction': '#d97706',
  'Closed':          '#64748b',
}

const RESULT_COLORS: Record<string, string> = {
  Won:       '#059669',
  Lost:      '#dc2626',
  Pending:   '#d97706',
  Cancelled: '#94a3b8',
}

const PORTAL_COLORS = [
  '#1e40af', '#7c3aed', '#0d9488', '#d97706', '#dc2626', '#64748b', '#ea580c',
]

/* ─────────────────────────────────────────────────────────────────
   FORMATTERS
───────────────────────────────────────────────────────────────── */
const fmtCr = (n: number) => {
  if (!n) return '0'
  if (n >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`
  if (n >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`
  return `₹ ${n.toLocaleString('en-IN')}`
}

const daysLeftLabel = (d: number) => {
  if (d < 0) return { label: `${Math.abs(d)}d overdue`, cls: 'bg-red-100 text-red-700 border-red-200' }
  if (d === 0) return { label: 'Due today!', cls: 'bg-red-100 text-red-700 border-red-200' }
  if (d <= 3) return { label: `${d}d left`, cls: 'bg-red-50 text-red-700 border-red-200' }
  if (d <= 7) return { label: `${d}d left`, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
  return { label: `${d}d left`, cls: 'bg-slate-50 text-slate-600 border-slate-200' }
}

/* ─────────────────────────────────────────────────────────────────
   SMART ALERT BANNER
───────────────────────────────────────────────────────────────── */
interface Alert { type: string; severity: 'high' | 'medium' | 'low'; message: string; tender_id?: number }

const SEVERITY_STYLE: Record<string, { bg: string; border: string; text: string; icon: React.ReactNode }> = {
  high:   { bg: 'bg-red-50',    border: 'border-red-200',    text: 'text-red-800',    icon: <AlertCircle size={14} className="text-red-500 flex-shrink-0" /> },
  medium: { bg: 'bg-amber-50',  border: 'border-amber-200',  text: 'text-amber-800',  icon: <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" /> },
  low:    { bg: 'bg-blue-50',   border: 'border-blue-200',   text: 'text-blue-800',   icon: <Info size={14} className="text-blue-500 flex-shrink-0" /> },
}

function AlertBanner({ alerts }: { alerts: Alert[] }) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set())
  const visible = alerts.filter((_, i) => !dismissed.has(i))

  if (!visible.length) return null

  const high   = visible.filter(a => a.severity === 'high')
  const medium = visible.filter(a => a.severity === 'medium')
  const low    = visible.filter(a => a.severity === 'low')

  const grouped = [...high, ...medium, ...low].slice(0, 6)

  return (
    <div className="overflow-hidden rounded-2xl border border-red-200 bg-gradient-to-r from-red-50 via-amber-50/30 to-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-red-100 px-5 py-3">
        <Bell size={14} className="text-red-500" />
        <span className="text-[13px] font-bold text-red-900">Smart Alerts</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
          {alerts.length} active
        </span>
        <button
          onClick={() => setDismissed(new Set(alerts.map((_, i) => i)))}
          className="ml-auto text-[11px] font-medium text-slate-500 hover:text-slate-700"
        >
          Dismiss all
        </button>
      </div>
      <div className="grid gap-0 divide-y divide-red-50">
        {grouped.map((a, i) => {
          const idx = alerts.indexOf(a)
          const s = SEVERITY_STYLE[a.severity]
          return (
            <div key={i} className={`flex items-start gap-3 px-5 py-3 ${s.bg}`}>
              {s.icon}
              <span className={`flex-1 text-[12.5px] ${s.text}`}>{a.message}</span>
              <button
                onClick={() => setDismissed(d => new Set([...d, idx]))}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   HERO KPI STRIP
───────────────────────────────────────────────────────────────── */
function HeroKpi({
  label, value, unit, sub, tone = 'neutral', delta, alert = false, spotlight = false,
}: {
  label: string; value: string | number; unit?: string; sub?: string
  tone?: 'pos' | 'neg' | 'warn' | 'info' | 'primary' | 'neutral' | 'violet'
  delta?: number; alert?: boolean; spotlight?: boolean
}) {
  const TONES: Record<string, string> = {
    pos:     'border-t-emerald-500',
    neg:     'border-t-red-500',
    warn:    'border-t-amber-500',
    info:    'border-t-sky-500',
    primary: 'border-t-blue-700',
    neutral: 'border-t-slate-300',
    violet:  'border-t-violet-600',
  }
  const VAL_COLOR: Record<string, string> = {
    pos: 'text-emerald-700', neg: 'text-red-700', warn: 'text-amber-700',
    info: 'text-sky-700', primary: 'text-blue-800', neutral: 'text-slate-900', violet: 'text-violet-700',
  }

  return (
    <div className={`relative flex flex-col gap-2 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md ${spotlight ? 'ring-2 ring-blue-200' : ''}`}>
      <span className={`absolute inset-x-0 top-0 h-1 rounded-t-2xl ${TONES[tone]}`} />
      {alert && (
        <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-red-100">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        </span>
      )}
      <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className={`text-[28px] font-extrabold leading-none tabular-nums ${VAL_COLOR[tone]}`}>{value}</span>
        {unit && <span className="text-[13px] font-semibold text-slate-500">{unit}</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        {sub && <span className="text-[11px] text-slate-500">{sub}</span>}
        {delta !== undefined && (
          <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${delta >= 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
            {delta >= 0 ? <ArrowUp size={9} /> : <ArrowDown size={9} />}{Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   STAGE PIPELINE FUNNEL
───────────────────────────────────────────────────────────────── */
function StagePipeline({ stages }: { stages: any[] }) {
  const { singular } = useModuleName('tenders')
  if (!stages?.length) return null
  const maxCount = Math.max(...stages.map(s => s.count || 0), 1)

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <div className="text-[13px] font-bold text-slate-900">Stage Pipeline</div>
        <div className="mt-0.5 text-[11px] text-slate-500">{singular} flow · count · value · conversion</div>
      </div>
      <div className="p-5">
        <div className="space-y-3">
          {stages.map((s, i) => {
            const barPct = (s.count / maxCount) * 100
            const conv = s.conversion ?? (i > 0 ? pct(s.count, stages[i - 1].count) : 100)
            const drop = s.drop_off ?? (i > 0 ? 100 - conv : 0)
            const color = STAGE_COLORS[s.stage] || T.slate

            return (
              <div key={s.stage} className="group">
                {i > 0 && (
                  <div className="mb-3 flex items-center gap-3 pl-2">
                    <div className="flex h-px flex-1 items-center bg-slate-100">
                      <div className="h-px flex-1" style={{ background: `${color}40` }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${conv >= 60 ? 'bg-emerald-50 text-emerald-700' : conv >= 30 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
                        {conv}% conv
                      </span>
                      {drop > 0 && (
                        <span className="text-[10px] text-slate-400">
                          ↘ {drop}% drop
                        </span>
                      )}
                    </div>
                    <div className="flex h-px flex-1 items-center bg-slate-100" />
                  </div>
                )}

                <div className="flex items-center gap-4">
                  <div className="w-[120px] flex-shrink-0">
                    <span className="text-[12px] font-semibold text-slate-700">{s.stage}</span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <div className="h-8 flex-1 overflow-hidden rounded-lg bg-slate-50">
                        <div
                          className="flex h-full items-center px-3 transition-all duration-700"
                          style={{ width: `${Math.max(barPct, 4)}%`, background: `${color}22`, borderLeft: `3px solid ${color}` }}
                        >
                          <span className="text-[12px] font-bold" style={{ color }}>{fmtN(s.count)}</span>
                        </div>
                      </div>
                      <span className="w-[90px] flex-shrink-0 text-right font-mono text-[11px] text-slate-600">
                        {fmtCr(s.value || 0)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   PORTAL PERFORMANCE TABLE
───────────────────────────────────────────────────────────────── */
function PortalTable({ rows }: { rows: any[] }) {
  const stats = useMemo(() => {
    const m: Record<string, { total: number; won: number; lost: number; pending: number; bid: number; est: number }> = {}
    rows.forEach(r => {
      const p = r.portal || r.source_portal || 'Direct'
      if (!m[p]) m[p] = { total: 0, won: 0, lost: 0, pending: 0, bid: 0, est: 0 }
      m[p].total++
      const res = (r.result || '').toLowerCase()
      if (res === 'won') m[p].won++
      else if (res === 'lost') m[p].lost++
      else m[p].pending++
      m[p].bid += num(r.bid_amount)
      m[p].est += num(r.est_value)
    })
    return Object.entries(m)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([portal, v], i) => ({
        portal, ...v,
        winRate: v.total ? Math.round((v.won / v.total) * 100) : 0,
        color: PORTAL_COLORS[i % PORTAL_COLORS.length],
      }))
  }, [rows])

  if (!stats.length) return null
  const maxWon = Math.max(...stats.map(s => s.won), 1)

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <div className="text-[13px] font-bold text-slate-900">Portal Performance</div>
        <div className="mt-0.5 text-[11px] text-slate-500">Win rate · bid value · channel comparison</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="px-5 py-3 text-left">Portal</th>
              <th className="px-4 py-3 text-right">Total</th>
              <th className="px-4 py-3 text-right text-emerald-700">Won</th>
              <th className="px-4 py-3 text-right text-red-600">Lost</th>
              <th className="px-4 py-3 text-right text-amber-700">Pending</th>
              <th className="px-4 py-3 text-right">Win %</th>
              <th className="px-4 py-3 text-right">Total Bid</th>
              <th className="px-5 py-3 text-left">Win Bar</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {stats.map(s => (
              <tr key={s.portal} className="transition-colors hover:bg-slate-50/60">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    <span className="text-[13px] font-semibold text-slate-900">{s.portal}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono text-[12.5px] font-semibold tabular-nums">{fmtN(s.total)}</td>
                <td className="px-4 py-3 text-right font-mono text-[12.5px] font-bold tabular-nums text-emerald-700">{fmtN(s.won)}</td>
                <td className="px-4 py-3 text-right font-mono text-[12.5px] tabular-nums text-red-600">{fmtN(s.lost)}</td>
                <td className="px-4 py-3 text-right font-mono text-[12.5px] tabular-nums text-amber-700">{fmtN(s.pending)}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold tabular-nums ${s.winRate >= 40 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : s.winRate >= 20 ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                    {s.winRate}%
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono text-[11.5px] tabular-nums text-slate-600">{fmtCr(s.bid)}</td>
                <td className="px-5 py-3">
                  <div className="h-2 w-28 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full transition-all" style={{ width: `${(s.won / maxWon) * 100}%`, background: s.color }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   BID DEADLINE CALENDAR  — compact redesign
───────────────────────────────────────────────────────────────── */
function BidCalendar({ calendar, tableRows }: { calendar: any[]; tableRows: any[] }) {
  const { singular } = useModuleName('tenders')
  const [month, setMonth] = useState(() => new Date())
  const [tooltip, setTooltip] = useState<{ evts: any[]; x: number; y: number } | null>(null)
  const today = new Date()

  const year = month.getFullYear()
  const mon  = month.getMonth()
  const firstDay   = new Date(year, mon, 1).getDay()
  const daysInMonth = new Date(year, mon + 1, 0).getDate()
  const DAY_NAMES  = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

  const calEvents = useMemo(() => {
    const events: Record<string, any[]> = {}
    const sources = calendar?.length ? calendar : tableRows.filter(r => r.submission_date)
    sources.forEach(r => {
      const dateStr = r.submission_date || r.date
      if (!dateStr) return
      const d = new Date(dateStr)
      if (d.getMonth() !== mon || d.getFullYear() !== year) return
      const key = d.getDate().toString()
      if (!events[key]) events[key] = []
      events[key].push(r)
    })
    return events
  }, [calendar, tableRows, mon, year])

  const upcomingList = useMemo(() => {
    const t = new Date()
    return (calendar?.length ? calendar : tableRows.filter(r => r.submission_date))
      .filter(r => {
        const d = r.submission_date || r.date
        if (!d) return false
        const diff = Math.floor((new Date(d).getTime() - t.getTime()) / 86400000)
        return diff >= 0 && diff <= 14
      })
      .sort((a, b) => (a.submission_date || a.date || '').localeCompare(b.submission_date || b.date || ''))
      .slice(0, 12)
  }, [calendar, tableRows])

  return (
    <div className="relative overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
        <span className="text-[11px] font-bold text-slate-800">Bid Calendar</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => setMonth(new Date(year, mon - 1))}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <ChevronLeft size={11} />
          </button>
          <span className="min-w-[80px] text-center text-[10px] font-semibold text-slate-600">
            {month.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </span>
          <button onClick={() => setMonth(new Date(year, mon + 1))}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <ChevronRight size={11} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_280px]">
        {/* Mini-calendar */}
        <div className="border-r border-slate-100 p-4">
          <div className="grid grid-cols-7 gap-1">
            {DAY_NAMES.map((d, idx) => (
              <div key={idx} className="flex h-6 items-center justify-center text-[9px] font-bold text-slate-400">
                {d}
              </div>
            ))}
            {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} className="h-8" />)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day  = i + 1
              const isToday = today.getDate() === day && today.getMonth() === mon && today.getFullYear() === year
              const evts = calEvents[day.toString()] || []
              const hasUrgent   = evts.some(e => { const diff = Math.floor((new Date(e.submission_date || e.date).getTime() - today.getTime()) / 86400000); return diff >= 0 && diff <= 3 })
              const hasUpcoming = !hasUrgent && evts.some(e => { const diff = Math.floor((new Date(e.submission_date || e.date).getTime() - today.getTime()) / 86400000); return diff > 3 && diff <= 7 })
              const hasScheduled = !hasUrgent && !hasUpcoming && evts.length > 0

              return (
                <div
                  key={day}
                  onMouseEnter={evts.length ? e => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setTooltip({ evts, x: r.left + r.width / 2, y: r.top })
                  } : undefined}
                  onMouseLeave={() => setTooltip(null)}
                  className={[
                    'relative flex h-8 w-full items-center justify-center rounded-md text-[10px] font-medium transition-colors',
                    evts.length ? 'cursor-pointer' : 'cursor-default',
                    isToday ? 'bg-blue-600 text-white font-bold shadow-sm' : '',
                    !isToday && hasUrgent   ? 'bg-red-100 text-red-700 hover:bg-red-200' : '',
                    !isToday && hasUpcoming ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : '',
                    !isToday && hasScheduled ? 'bg-blue-50 text-blue-700 hover:bg-blue-100' : '',
                    !isToday && !evts.length ? 'text-slate-400 hover:bg-slate-50' : '',
                  ].join(' ')}
                >
                  {day}
                  {evts.length > 0 && (
                    <span className={`absolute bottom-1 h-[3px] w-[3px] rounded-full ${
                      isToday ? 'bg-white/80' : hasUrgent ? 'bg-red-500' : hasUpcoming ? 'bg-amber-500' : 'bg-blue-400'
                    }`} />
                  )}
                </div>
              )
            })}
          </div>
          {/* Legend */}
          <div className="mt-3 flex items-center gap-3 border-t border-slate-100 pt-3">
            {[{ cls: 'bg-red-400', text: '≤3d' }, { cls: 'bg-amber-400', text: '≤7d' }, { cls: 'bg-blue-300', text: 'Later' }].map(l => (
              <div key={l.text} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${l.cls}`} />
                <span className="text-[9px] text-slate-400">{l.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Next 14 days */}
        <div className="flex flex-col overflow-hidden bg-slate-50/40">
          <div className="border-b border-slate-200 px-4 py-3 flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Next 14 Days</span>
            {upcomingList.length > 0 && (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[9px] font-bold text-blue-600">
                {upcomingList.length}
              </span>
            )}
          </div>
          <div className="overflow-y-auto divide-y divide-slate-100 max-h-[340px]">
            {upcomingList.length === 0 ? (
              <div className="flex h-full items-center justify-center text-[10px] text-slate-400 py-8">
                No upcoming bids
              </div>
            ) : upcomingList.map((r, i) => {
              const dateStr = r.submission_date || r.date
              const diff = Math.floor((new Date(dateStr).getTime() - today.getTime()) / 86400000)
              const dl   = daysLeftLabel(diff)
              const fmtDate = dateStr ? new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''
              return (
                <div key={i} className="px-4 py-3 hover:bg-white transition-colors">
                  {/* Title + badge */}
                  <div className="flex items-start gap-2 mb-1">
                    <span className="line-clamp-2 flex-1 text-[11px] font-semibold leading-snug text-slate-900">
                      {r.title || r.tender_title || `#${r.id}`}
                    </span>
                    <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold leading-none ${dl.cls}`}>
                      {dl.label}
                    </span>
                  </div>
                  {/* Customer */}
                  {(r.customer || r.customer_name) && (
                    <div className="text-[10px] text-slate-500 leading-tight truncate mb-1.5">
                      {r.customer || r.customer_name}
                    </div>
                  )}
                  {/* Meta row: date + ref + portal */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {fmtDate && (
                      <span className="text-[9px] text-slate-500 font-medium bg-white border border-slate-200 px-1.5 py-0.5 rounded">{fmtDate}</span>
                    )}
                    {(r.reference_num || r.tender_num || r.reference) && (
                      <span className="text-[8.5px] font-mono text-slate-400 truncate max-w-[100px]">
                        {r.reference_num || r.tender_num || r.reference}
                      </span>
                    )}
                    {(r.portal_name || r.portal) && (
                      <span className="text-[8.5px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded border border-slate-200">
                        {r.portal_name || r.portal}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Floating hover tooltip */}
      {tooltip && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y - 8, transform: 'translate(-50%, -100%)' }}
        >
          <div className="rounded-lg border border-slate-200 bg-white shadow-xl p-2.5 min-w-[200px] max-w-[260px]">
            {tooltip.evts.map((e, i) => {
              const dateStr = e.submission_date || e.date
              const diff = dateStr ? Math.floor((new Date(dateStr).getTime() - today.getTime()) / 86400000) : null
              const dl   = diff !== null ? daysLeftLabel(diff) : null
              return (
                <div key={i} className={`${i > 0 ? 'mt-2 border-t border-slate-100 pt-2' : ''}`}>
                  <div className="flex items-start justify-between gap-2 mb-0.5">
                    <span className="text-[11px] font-bold text-slate-900 leading-tight">
                      {e.title || e.tender_title || `${singular} #${e.id}`}
                    </span>
                    {dl && (
                      <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[8px] font-bold ${dl.cls}`}>
                        {dl.label}
                      </span>
                    )}
                  </div>
                  {(e.customer || e.customer_name) && (
                    <div className="text-[10px] text-slate-500 truncate">{e.customer || e.customer_name}</div>
                  )}
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {dateStr && (
                      <span className="text-[9px] text-slate-400 font-medium">
                        {new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </span>
                    )}
                    {(e.reference_num || e.tender_num) && (
                      <span className="text-[9px] font-mono text-slate-400">{e.reference_num || e.tender_num}</span>
                    )}
                    {(e.portal_name || e.portal) && (
                      <span className="text-[9px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-medium">{e.portal_name || e.portal}</span>
                    )}
                    {(e.est_value || e.bid_amount) && (
                      <span className="text-[9px] font-semibold text-emerald-700">{fmtCr(e.est_value || e.bid_amount)}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {/* Tooltip arrow */}
          <div className="mx-auto h-2 w-2 rotate-45 border-b border-r border-slate-200 bg-white -mt-px" style={{ marginLeft: 'calc(50% - 4px)' }} />
        </div>
      )}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   RESULT DONUT
───────────────────────────────────────────────────────────────── */
function ResultDonut({ data }: { data: any[] }) {
  const { singular } = useModuleName('tenders')
  const total = data.reduce((s, d) => s + (d.count || d.value || 0), 0)
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <div className="text-[13px] font-bold text-slate-900">{singular} Results</div>
        <div className="mt-0.5 text-[11px] text-slate-500">Win / Loss / Pending breakdown</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center px-4 pb-4 pt-2">
        <div className="relative w-full" style={{ height: 200 }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey={data[0]?.count !== undefined ? 'count' : 'value'}
                nameKey="name"
                cx="50%" cy="48%"
                innerRadius="52%" outerRadius="72%"
                paddingAngle={2} strokeWidth={0}
              >
                {data.map((d, i) => (
                  <Cell key={i} fill={RESULT_COLORS[d.name] || PORTAL_COLORS[i % PORTAL_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip content={<ChartTip />} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-2xl font-extrabold tabular-nums text-slate-900">{fmtN(total)}</div>
            <div className="text-[10px] font-medium text-slate-400">Total</div>
          </div>
        </div>
        <div className="mt-1 grid w-full grid-cols-2 gap-2">
          {data.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ fill: RESULT_COLORS[d.name], background: RESULT_COLORS[d.name] || PORTAL_COLORS[i % PORTAL_COLORS.length] }} />
              <span className="flex-1 truncate text-[11px] text-slate-600">{d.name}</span>
              <span className="font-mono text-[11px] font-bold tabular-nums text-slate-800">{fmtN(d.count || d.value || 0)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   MONTHLY TREND CHART
───────────────────────────────────────────────────────────────── */
function MonthlyTrend({ data }: { data: any[] }) {
  const { singular } = useModuleName('tenders')
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <div className="text-[13px] font-bold text-slate-900">Monthly Trend</div>
        <div className="mt-0.5 text-[11px] text-slate-500">{singular} count · won value · submitted value</div>
      </div>
      <div style={{ height: 260 }} className="px-2 pb-4 pt-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 16, bottom: 0, left: -10 }}>
            <defs>
              <linearGradient id="wonGr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={T.pos} stopOpacity={0.12} />
                <stop offset="100%" stopColor={T.pos} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="subGr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={T.primary2} stopOpacity={0.12} />
                <stop offset="100%" stopColor={T.primary2} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...CGRID} />
            <XAxis dataKey="month" tick={AXIS_X} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
            <YAxis yAxisId="left" tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
            <YAxis yAxisId="right" orientation="right" tick={AXIS_Y} axisLine={false} tickLine={false} width={48}
              tickFormatter={v => v >= 1e7 ? `${(v / 1e7).toFixed(0)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(0)}L` : `${v}`} />
            <Tooltip content={<ChartTip />} />
            <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 10, paddingTop: 4 }}
              formatter={(v) => <span style={{ color: T.slate }}>{v}</span>} />
            <Bar yAxisId="left" dataKey="count" name="Count" fill={`${T.primary}55`} radius={[3, 3, 0, 0]} barSize={20} />
            <Area yAxisId="right" type="monotone" dataKey="won_value" name="Won ₹" stroke={T.pos}
              strokeWidth={2} fill="url(#wonGr)"
              dot={{ r: 3, fill: T.pos, stroke: '#fff', strokeWidth: 1.5 }} />
            <Area yAxisId="right" type="monotone" dataKey="submitted_value" name="Submitted ₹" stroke={T.primary2}
              strokeWidth={2} fill="url(#subGr)"
              dot={{ r: 3, fill: T.primary2, stroke: '#fff', strokeWidth: 1.5 }} strokeDasharray="4 2" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   TOP USERS TABLE
───────────────────────────────────────────────────────────────── */
function TopUsersTable({ users }: { users: any[] }) {
  const { labelLower, singular } = useModuleName('tenders')
  if (!users?.length) return null
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm mt-4">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <div className="text-[13px] font-bold text-slate-900">Top KAMs by {singular} Performance</div>
        <div className="mt-0.5 text-[11px] text-slate-500">Assigned {labelLower} · won count · win rate</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="px-5 py-2.5 text-left">#</th>
              <th className="px-4 py-2.5 text-left">Name</th>
              <th className="px-4 py-2.5 text-right">Assigned</th>
              <th className="px-4 py-2.5 text-right text-emerald-700">Won</th>
              <th className="px-4 py-2.5 text-right">Win Rate</th>
              <th className="px-5 py-2.5 text-right">Won Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {users.map((u, i) => {
              const wr = u.total ? Math.round((u.won / u.total) * 100) : 0
              return (
                <tr key={i} className="transition-colors hover:bg-slate-50/60">
                  <td className="px-5 py-2.5 font-bold text-slate-400">#{i + 1}</td>
                  <td className="px-4 py-2.5 font-semibold text-slate-900">{u.name || u.assigned_to_name || '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmtN(u.total)}</td>
                  <td className="px-4 py-2.5 text-right font-bold tabular-nums text-emerald-700">{fmtN(u.won)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-bold ${wr >= 40 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : wr >= 20 ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                      {wr}%
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-700">{fmtCr(u.won_value || 0)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   TOP CUSTOMERS TABLE
───────────────────────────────────────────────────────────────── */
function TopCustomers({ customers }: { customers: any[] }) {
  const { label, singular } = useModuleName('tenders')
  const { label: customerLabel, singular: customerSingular } = useModuleName('customers')
  if (!customers?.length) return null
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm mt-4">
      <div className="border-b border-slate-100 px-5 py-3.5">
        <div className="text-[13px] font-bold text-slate-900">Top {customerLabel} by {singular} Value</div>
        <div className="mt-0.5 text-[11px] text-slate-500">Estimated value · bid amount · count</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="px-5 py-2.5 text-left">#</th>
              <th className="px-4 py-2.5 text-left">{customerSingular}</th>
              <th className="px-4 py-2.5 text-right">{label}</th>
              <th className="px-4 py-2.5 text-right text-emerald-700">Won</th>
              <th className="px-4 py-2.5 text-right">Est. Value</th>
              <th className="px-5 py-2.5 text-right">Bid Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {customers.map((c, i) => (
              <tr key={i} className="transition-colors hover:bg-slate-50/60">
                <td className="px-5 py-2.5 font-bold text-slate-400">#{i + 1}</td>
                <td className="px-4 py-2.5 font-semibold text-slate-900">{c.name || c.customer_name || '—'}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{fmtN(c.total || c.count || 0)}</td>
                <td className="px-4 py-2.5 text-right font-bold tabular-nums text-emerald-700">{fmtN(c.won || 0)}</td>
                <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">{fmtCr(c.est_value || c.value || 0)}</td>
                <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-700">{fmtCr(c.bid_value || c.bid || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   SECONDARY FINANCE KPIs
───────────────────────────────────────────────────────────────── */
function FinanceKpiStrip({ s }: { s: any }) {
  const { label, singularLower } = useModuleName('tenders')
  const { singular: emdSingular } = useModuleName('emdbg')
  const avg  = num(s.total) ? Math.round(num(s.pipeline_value) / num(s.total)) : 0
  const avgS = splitRs(avg)
  const pendS = splitRs(num(s.pending_value) || num(s.pipeline_value))
  const emdValS = splitRs(num(s.emd_total_value))

  const cards = [
    { label: 'Won Value',       value: splitRs(num(s.won_value)).val,   unit: splitRs(num(s.won_value)).unit ? `₹${splitRs(num(s.won_value)).unit}` : '₹', tone: 'pos' as const, delta: 23.1, sub: 'Year to date' },
    { label: 'Pending Value',   value: pendS.val,   unit: pendS.unit ? `₹${pendS.unit}` : '₹', tone: 'warn' as const, sub: 'Open pipeline' },
    { label: 'Avg Bid Value',   value: avgS.val,    unit: avgS.unit ? `₹${avgS.unit}` : '₹', tone: 'info' as const, sub: `Per ${singularLower}` },
    { label: `${emdSingular} Required`, value: fmtN(num(s.emd_required_count)), tone: 'neutral' as const, sub: `${label} need ${emdSingular}`, alert: num(s.emd_required_count) > 0 },
    { label: `${emdSingular} Value`,    value: emdValS.val, unit: emdValS.unit ? `₹${emdValS.unit}` : '₹', tone: 'neutral' as const, sub: `Total ${emdSingular} at stake` },
    { label: 'Bids Due 7d',     value: fmtN(num(s.upcoming_bids)), tone: num(s.upcoming_bids) > 0 ? 'neg' as const : 'neutral' as const, alert: num(s.upcoming_bids) > 0, sub: num(s.urgent_bids) > 0 ? `${num(s.urgent_bids)} urgent` : 'Action required' },
  ]

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {cards.map((c, i) => (
        <HeroKpi key={i} {...c} />
      ))}
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────────
   MAIN TENDERS TAB
───────────────────────────────────────────────────────────────── */
export default function TendersTab() {
  const { label, singular, labelLower, singularLower } = useModuleName('tenders')
  const { label: customerLabel, singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const [data,           setData]           = useState<any>(null)
  const [loading,        setLoading]        = useState(true)
  const [filters,        setFilters]        = useState<FilterState>(EMPTY_FILTERS)
  const [pendingFilters, setPendingFilters] = useState<FilterState>(EMPTY_FILTERS)
// s_comparison
  const SECTION_DEFAULTS = ['s_pulse', 's_finance', 's_pipeline', 's_trends', 's_calendar', 's_portal', 's_top', 's_table']
  const { order, onDragStart, onDragOver, onDrop } = useSectionDrag('tenders_sections', SECTION_DEFAULTS)
  const [arranging, setArranging] = useState(false)

  const loadData = useCallback(async (f: FilterState) => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v) })
      const res = await api.get(`/dashboard/tab/tenders?${p}`)
      setData(res.data)
    } catch { setData(null) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadData(EMPTY_FILTERS) }, [loadData])

  const handleChange = (k: keyof FilterState, v: string) => setPendingFilters(p => ({ ...p, [k]: v }))
  const handleApply  = () => { setFilters(pendingFilters); loadData(pendingFilters) }
  const handleReset  = () => { setFilters(EMPTY_FILTERS); setPendingFilters(EMPTY_FILTERS); loadData(EMPTY_FILTERS) }

  if (loading && !data) return <TabSkeleton />

  const s  = data?.summary   || {}
  const c  = data?.charts    || {}
  const tl = data?.top_lists || {}
  const tableRows: any[] = data?.table    || []
  const alerts: Alert[]  = data?.alerts   || []
  const calendar: any[]  = data?.calendar || []

  const winRate   = num(s.total) ? Math.round((num(s.won) / num(s.total)) * 100) : 0
  const wonSplit  = splitRs(num(s.won_value))
  const pipeSplit = splitRs(num(s.pipeline_value))

  // Derive pipeline stages from charts or tableRows
  const pipelineStages = c.pipeline_stages?.length
    ? c.pipeline_stages
    : (() => {
        const stageOrder = ['Aligned', 'Evaluation', 'Pre-Bid', 'Submitted', 'Reverse Auction', 'Closed']
        const m: Record<string, { count: number; value: number }> = {}
        tableRows.forEach(r => {
          const st = r.status || r.tender_status || 'Aligned'
          if (!m[st]) m[st] = { count: 0, value: 0 }
          m[st].count++
          m[st].value += num(r.est_value)
        })
        return stageOrder.filter(st => m[st]).map((stage, i, arr) => ({
          stage,
          count: m[stage]?.count || 0,
          value: m[stage]?.value || 0,
          conversion: i > 0 && m[arr[i - 1]]?.count
            ? Math.round(((m[stage]?.count || 0) / m[arr[i - 1]].count) * 100) : 100,
        }))
      })()

  // Derive top users from table if not in top_lists
  const topUsers = tl.top_users?.length
    ? tl.top_users
    : (() => {
        const m: Record<string, { name: string; total: number; won: number; won_value: number }> = {}
        tableRows.forEach(r => {
          const name = r.assigned_to || 'Unassigned'
          if (!m[name]) m[name] = { name, total: 0, won: 0, won_value: 0 }
          m[name].total++
          if (r.result === 'Won') { m[name].won++; m[name].won_value += num(r.bid_amount) }
        })
        return Object.values(m).sort((a, b) => b.won - a.won).slice(0, 8)
      })()

  // Derive top customers from table if not in top_lists
  const topCustomers = tl.top_customers?.length
    ? tl.top_customers
    : (() => {
        const m: Record<string, { name: string; total: number; won: number; est_value: number; bid_value: number }> = {}
        tableRows.forEach(r => {
          const name = r.customer || '—'
          if (!m[name]) m[name] = { name, total: 0, won: 0, est_value: 0, bid_value: 0 }
          m[name].total++
          if (r.result === 'Won') m[name].won++
          m[name].est_value += num(r.est_value)
          m[name].bid_value += num(r.bid_amount)
        })
        return Object.values(m).sort((a, b) => b.est_value - a.est_value).slice(0, 8)
      })()

  // Build smart alerts from table if backend doesn't return them
  const derivedAlerts: Alert[] = alerts.length ? alerts : (() => {
    const out: Alert[] = []
    const today = new Date()
    tableRows.forEach(r => {
      if (r.submission_date) {
        const diff = Math.floor((new Date(r.submission_date).getTime() - today.getTime()) / 86400000)
        if (diff === 0) out.push({ type: 'submission_due', severity: 'high', message: `Submission due TODAY: ${r.title || r.num || r.id} — ${r.customer}`, tender_id: r.id })
        else if (diff < 0 && r.result === 'Pending') out.push({ type: 'overdue', severity: 'high', message: `Overdue submission (${Math.abs(diff)}d ago): ${r.title || r.num || r.id}`, tender_id: r.id })
        else if (diff <= 3 && diff > 0) out.push({ type: 'urgent', severity: 'medium', message: `Bid due in ${diff}d: ${r.title || r.num || r.id} — ${r.customer}`, tender_id: r.id })
      }
      if (r.result === 'Won' && !r.po_num) out.push({ type: 'won_without_po', severity: 'medium', message: `Won ${singularLower} missing PO: ${r.title || r.num || r.id}`, tender_id: r.id })
      if (r.result === 'Lost' && !r.loss_analysis) out.push({ type: 'no_loss_analysis', severity: 'low', message: `Lost without analysis: ${r.title || r.num || r.id}`, tender_id: r.id })
    })
    return out.slice(0, 10)
  })()

  const cols: ColDef[] = [
    { key: 'num',             label: 'No.',        render: v => <span className="font-mono text-[10px] text-slate-400">{v || '—'}</span> },
    { key: 'title',           label: 'Title',      render: v => <span className="line-clamp-1 block max-w-[240px] font-semibold text-slate-900">{v}</span> },
    { key: 'customer',        label: customerSingular },
    { key: 'portal',          label: 'Portal',     render: v => v ? <Badge text={v} tone="neutral" dot={false} /> : null },
    { key: 'status',          label: 'Status',     render: v => v ? <Badge text={v} /> : null },
    { key: 'result',          label: 'Result',     render: v => v ? <Badge text={v} tone={v === 'Won' ? 'pos' : v === 'Lost' ? 'neg' : 'warn'} /> : null },
    { key: 'est_value',       label: 'Est ₹',      money: true, align: 'right' },
    { key: 'bid_amount',      label: 'Bid ₹',      money: true, align: 'right' },
    { key: 'submission_date', label: 'Deadline' },
    { key: 'days_left',       label: 'Days Left',  render: (v, row) => {
      if (row.submission_date) {
        const diff = Math.floor((new Date(row.submission_date).getTime() - new Date().getTime()) / 86400000)
        const dl = daysLeftLabel(diff)
        return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${dl.cls}`}>{dl.label}</span>
      }
      return null
    }},
    { key: 'assigned_to',     label: 'KAM' },
  ]

  const byResult = c.by_result?.length ? c.by_result : (() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => { const k = r.result || 'Pending'; m[k] = (m[k] || 0) + 1 })
    return Object.entries(m).map(([name, count]) => ({ name, count }))
  })()

  return (
    <div className="space-y-5 p-6">

      {/* ── Header ────────────────────────────────────────────────────── */}
      <ModuleHead
        icon={<FileText size={20} />}
        title={`${singular} Analytics`}
        subtitle="Pipeline · outcomes · portal performance · bid calendar"
        stats={[
          { label: 'Total',    value: fmtN(num(s.total)) },
          { label: 'Active',   value: fmtN(num(s.active)),  tone: 'info' },
          { label: 'Won',      value: fmtN(num(s.won)),     tone: 'pos' },
          { label: 'Pipeline Value', value: fmtRsL(num(s.pipeline_value)), tone: 'primary' },
        ]}
        onRefresh={() => loadData(filters)}
        loading={loading}
        extra={
          <button
            onClick={() => setArranging((a) => !a)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              arranging ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Settings2 size={13} />
            {arranging ? 'Done' : 'Arrange'}
          </button>
        }
      />

      {/* ── Filters ────────────────────────────────────────────────────── */}
      <FilterBar
        filters={pendingFilters}
        onChange={handleChange}
        onApply={handleApply}
        onReset={handleReset}
        filterOptions={data?.filters || {}}
        loading={loading}
      />

      {/* ── 01 Smart Alerts — always shown when present, not draggable ── */}
      {derivedAlerts.length > 0 && (
        <>
          <Section idx="01" title="Smart Alerts" desc={`${derivedAlerts.length} items need attention`} />
          <AlertBanner alerts={derivedAlerts} />
        </>
      )}

      {/* ── Draggable sections ──────────────────────────────────────────── */}
      {order.map((id) => {
        // if (id === 's_pulse') return (
        //   <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
        //     <Section idx="02" title="Pulse" desc="Pipeline & outcome summary" />
        //     <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        //       <HeroKpi label="Total Tenders"    value={fmtN(num(s.total))}              tone="primary"  delta={18.2} sub="All time" />
        //       <HeroKpi label="Active"           value={fmtN(num(s.active))}             tone="info"     sub={`${num(s.submitted || 0)} submitted`} />
        //       <HeroKpi label="Submitted"        value={fmtN(num(s.submitted))}          tone="info"     sub="Awaiting result" />
        //       <HeroKpi label="Won"              value={fmtN(num(s.won))}                tone="pos"      delta={4.5} sub="This period" spotlight />
        //       <HeroKpi label="Lost"             value={fmtN(num(s.lost))}               tone="neg"      sub={`${winRate}% win rate`} />
        //       <HeroKpi label="Pipeline Value"   value={pipeSplit.val}                   unit={pipeSplit.unit ? `₹${pipeSplit.unit}` : '₹'} tone="primary" delta={6.8} />
        //     </div>
        //   </DragSection>
        // )
        if (id === 's_finance') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="03" title="Finance Metrics" desc="Value · EMD · deadlines" />
            <FinanceKpiStrip s={s} />
          </DragSection>
        )
        if (id === 's_pipeline') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="04" title="Pipeline & Results" desc="Stage conversion funnel · outcome distribution" />
            <div className="grid grid-cols-[1.6fr_1fr] gap-4">
              <StagePipeline stages={pipelineStages} />
              <ResultDonut data={byResult} />
            </div>
          </DragSection>
        )
        if (id === 's_trends') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="05" title="Trends & Channels" desc="Monthly volume · portal distribution" />
            <div className="grid grid-cols-[1.5fr_1fr] gap-4">
              <MonthlyTrend data={c.monthly_trend || []} />
              <ChartShell title="By Portal" sub={`${singular} count per source`} height={260}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={(c.by_portal || []).slice(0, 8)}
                    layout="vertical"
                    barSize={14}
                    margin={{ top: 4, right: 16, bottom: 0, left: 64 }}
                  >
                    <CartesianGrid {...CGRID} horizontal={false} vertical />
                    <XAxis type="number" tick={AXIS_Y} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={AXIS_X} axisLine={false} tickLine={false} width={60} />
                    <Tooltip content={<ChartTip />} />
                    <Bar dataKey="value" name={label} radius={[0, 4, 4, 0]}>
                      {(c.by_portal || []).map((_: any, i: number) => (
                        <Cell key={i} fill={PORTAL_COLORS[i % PORTAL_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartShell>
            </div>
          </DragSection>
        )
        if (id === 's_calendar') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="06" title="Bid Submission Calendar" desc="Deadline heat map · upcoming list" />
            {/* <div className="max-w-2xl"> */}
              <BidCalendar calendar={calendar} tableRows={tableRows} />
            {/* </div> */}
          </DragSection>
        )
        if (id === 's_portal') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="07" title="Portal Comparison" desc="Win rate · bid value by channel" />
            <PortalTable rows={tableRows} />
          </DragSection>
        )
        if (id === 's_top') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="08" title="Top Performers" desc={`Highest value · top ${customerLabelLower} · top KAMs`} />
            <div className="grid grid-cols-2 gap-4">
              <TopList
                title="Top by Estimated Value"
                items={tl.highest_estimated || tl.by_est || tl.by_bid || []}
                nameKey="title" valueKey="value" subKey="customer"
                valueFmt={fmtCr} accentColor={T.primary}
              />
              <TopList
                title="Top by Bid Amount"
                items={tl.highest_bid || tl.by_bid || []}
                nameKey="title" valueKey="bid" subKey="customer"
                valueFmt={fmtCr} accentColor={T.pos}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <TopCustomers customers={topCustomers} />
              <TopUsersTable users={topUsers} />
            </div>
          </DragSection>
        )
        if (id === 's_comparison') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="09" title="Period Comparison" desc="Current vs previous period" />
            <ComparisonPanel
              title={`${singular} metrics · current vs previous period`}
              rows={[
                { label: `Total ${labelLower}`,  current: num(s.total),          previous: num(s.prev_total),        fmt: fmtN },
                { label: 'Won',            current: num(s.won),            previous: num(s.prev_won),          fmt: fmtN },
                { label: 'Win rate',       current: winRate,
                  previous: num(s.prev_total) ? pct(num(s.prev_won), num(s.prev_total)) : 0, fmt: (v: number) => `${v}%` },
                { label: 'Won value',      current: num(s.won_value),      previous: num(s.prev_won_value),    fmt: fmtCr },
                { label: 'Pipeline value', current: num(s.pipeline_value), previous: num(s.prev_pipeline),     fmt: fmtCr },
              ]}
            />
          </DragSection>
        )
        if (id === 's_table') return (
          <DragSection key={id} id={id} arranging={arranging} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
            <Section idx="10" title={`All ${label}`} desc={`${tableRows.length} records`} />
            <DataTable rows={tableRows} columns={cols} title="tenders" />
          </DragSection>
        )
        return null
      })}
    </div>
  )
}