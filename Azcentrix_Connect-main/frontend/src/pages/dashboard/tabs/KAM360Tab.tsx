/**
 * KAM360Tab.tsx — Key Account Manager 360° Analytics
 * Cross-module view: every KAM's performance on Customers, Leads, Tenders, Travel, EMD/BG
 * Sections:
 *  01  KPI overview (team-level totals)
 *  02  Group comparison table + group KPI cards
 *  03  KAM scorecard table (main: all modules per KAM)
 *  04  Leaderboard — top performers per category
 *  05  Charts: group performance bar, activity trend
 */
import { useEffect, useState, useCallback, useMemo, Fragment } from 'react'
import { Compass, Award, Users, TrendingUp, Star, AlertCircle, RefreshCw, Download, Settings2, ChevronRight } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area, RadarChart, Radar, PolarGrid, PolarAngleAxis, Cell, Legend,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, CHART, fmtN, fmtRsL, num, pct,
  ChartTip, Badge, KpiCard, ChartShell, Section, TabSkeleton,
  AXIS_X, AXIS_Y, CGRID, FilterState, EMPTY_FILTERS,
} from './_shared'

// ─── KAM data shape (from /dashboard/tab/kam360) ─────────────────────────────
interface KAMRow {
  id: number
  name: string
  group: string
  region: string
  customers_total: number
  customers_active: number
  leads_total: number
  leads_converted: number
  leads_lost: number
  leads_overdue: number
  leads_pipeline: number
  tenders_total: number
  tenders_won: number
  tenders_bid_value: number
  travel_total: number
  emdbg_active: number
  score?: number
  sales_target?: number
  won_tender_value?: number
  customers_with_win?: number
  customers_pending?: number
  lead_value?: number
  customer_potential_value?: number
}
interface GroupRow {
  name: string
  members: number
  customers_total: number
  customers_active: number
  leads_total: number
  leads_converted: number
  lead_value: number
  active_leads_count?: number
  active_lead_value?: number
  tenders_total: number
  tenders_won: number
  tender_value: number
  active_tenders_count?: number
  active_tender_value?: number
  pipeline: number
  active_pipeline_count?: number
  active_pipeline_value?: number
  potential_value: number
  won_value: number
  won_count?: number
  won_pipeline_value?: number
}
interface CustomerRow {
  id: number
  customer_name: string
  city?: string
  vertical?: string
  status?: string
  potential_value?: number
  lead_value: number
  lead_count?: number
  tender_value: number
  tender_count?: number
  won_value: number
  won_count?: number
  activity_count?: number
}

// ─── Simple score formula ─────────────────────────────────────────────────────
function calcScore(k: KAMRow): number {
  const custRate   = k.customers_total ? pct(k.customers_active, k.customers_total)         : 0
  const convRate   = k.leads_total     ? pct(k.leads_converted,  k.leads_total)              : 0
  const winRate    = k.tenders_total   ? pct(k.tenders_won,      k.tenders_total)            : 0
  const overdueRat = k.leads_total     ? 100 - pct(k.leads_overdue, k.leads_total)           : 100
  return Math.round(custRate * 0.2 + convRate * 0.35 + winRate * 0.3 + overdueRat * 0.15)
}

function fromKamTeam360(payload: any) {
  const members = Array.isArray(payload?.members) ? payload.members : []
  const masterGroups = Array.isArray(payload?.master_groups) ? payload.master_groups : []
  const NON_KAM_ROLES = ['admin', 'ceo']
  const kams: KAMRow[] = members
    .filter((m: any) => !NON_KAM_ROLES.includes((m.role || '').toLowerCase()))
    .map((m: any) => {
    const row: KAMRow = {
      id: num(m.user_id),
      name: m.user_name || m.full_name || 'Unassigned',
      group: m.group_name || (m.group_id ? String(m.group_id) : 'Unassigned'),
      region: '',
      customers_total: num(m.customers),
      customers_active: num(m.customers_active ?? m.active_customers ?? m.customers),
      leads_total: num(m.lead_count),
      leads_converted: num(m.converted_opportunity_count ?? m.leads_converted ?? m.converted_leads),
      leads_lost: num(m.lost_lead_count ?? m.leads_lost),
      leads_overdue: num(m.overdue_lead_count ?? m.leads_overdue),
      leads_pipeline: num(m.active_lead_value ?? m.lead_value),
      tenders_total: num(m.tender_count),
      tenders_won: num(m.won_tender_count),
      tenders_bid_value: num(m.tender_value),
      travel_total: num(m.travel_total ?? m.total_activities ?? m.total),
      emdbg_active: num(m.emdbg_active),
      sales_target: num(m.sales_target),
      won_tender_value: num(m.won_tender_value),
      customers_with_win: num(m.customers_with_win),
      customers_pending: num(m.customers_pending),
      lead_value: num(m.lead_value),
      customer_potential_value: num(m.customer_potential_value ?? m.potential_value),
    }
    return { ...row, score: calcScore(row) }
  })

  const groupMap = new Map<string, GroupRow>()
  kams.forEach(k => {
    const name = k.group || 'Unassigned'
    const g = groupMap.get(name) || {
      name,
      members: 0,
      customers_total: 0,
      customers_active: 0,
      leads_total: 0,
      leads_converted: 0,
      lead_value: 0,
      active_leads_count: 0,
      active_lead_value: 0,
      tenders_total: 0,
      tenders_won: 0,
      tender_value: 0,
      active_tenders_count: 0,
      active_tender_value: 0,
      pipeline: 0,
      active_pipeline_count: 0,
      active_pipeline_value: 0,
      potential_value: 0,
      won_value: 0,
      won_count: 0,
      won_pipeline_value: 0,
    }
    g.members += 1
    g.customers_total += k.customers_total
    g.customers_active += k.customers_active
    g.leads_total += k.leads_total
    g.leads_converted += k.leads_converted
    g.lead_value += k.lead_value || 0
    g.active_leads_count! += k.leads_total
    g.active_lead_value! += k.lead_value || 0
    g.tenders_total += k.tenders_total
    g.tenders_won += k.tenders_won
    g.tender_value += k.tenders_bid_value
    g.active_tenders_count! += k.tenders_total
    g.active_tender_value! += k.tenders_bid_value
    g.pipeline += k.leads_pipeline
    g.active_pipeline_count! += k.leads_total + k.tenders_total
    g.active_pipeline_value! += (k.lead_value || 0) + k.tenders_bid_value
    g.potential_value += k.customer_potential_value || 0
    g.won_value += k.won_tender_value || 0
    g.won_count! += k.tenders_won
    g.won_pipeline_value! += k.won_tender_value || 0
    groupMap.set(name, g)
  })

  const backendGroups: GroupRow[] = masterGroups
    .map((g: any) => ({
      name: g.name || g.group_name || 'Unassigned',
      members: num(g.kam_member_count ?? g.member_count ?? g.members?.length),
      customers_total: num(g.customer_count ?? g.customers_total),
      customers_active: num(g.active_customer_count ?? g.customers_active ?? g.customer_count ?? g.customers_total),
      leads_total: num(g.lead_count ?? g.leads_total),
      leads_converted: num(g.converted_opportunity_count ?? g.leads_converted),
      lead_value: num(g.lead_value),
      active_leads_count: num(g.active_leads_count ?? g.lead_count ?? g.leads_total),
      active_lead_value: num(g.active_lead_value ?? g.lead_value),
      tenders_total: num(g.tender_count ?? g.tenders_total),
      tenders_won: num(g.won_tender_count ?? g.tenders_won),
      tender_value: num(g.tender_value),
      active_tenders_count: num(g.active_tenders_count ?? g.tender_count ?? g.tenders_total),
      active_tender_value: num(g.active_tender_value ?? g.tender_value),
      pipeline: num(g.pipeline ?? g.active_pipeline_value ?? ((g.active_lead_value ?? g.lead_value ?? 0) + (g.active_tender_value ?? g.tender_value ?? 0))),
      active_pipeline_count: num(g.active_pipeline_count ?? ((g.active_leads_count ?? g.lead_count ?? g.leads_total ?? 0) + (g.active_tenders_count ?? g.tender_count ?? g.tenders_total ?? 0))),
      active_pipeline_value: num(g.active_pipeline_value ?? ((g.active_lead_value ?? g.lead_value ?? 0) + (g.active_tender_value ?? g.tender_value ?? 0))),
      potential_value: num(g.customer_potential_value ?? g.potential_value),
      won_value: num(g.won_pipeline_value ?? g.won_tender_value ?? g.won_value),
      won_count: num(g.won_count ?? g.won_tender_count ?? g.tenders_won),
      won_pipeline_value: num(g.won_pipeline_value ?? g.won_tender_value ?? g.won_value),
    }))
    .filter(g => g.name.trim().toLowerCase() !== 'unassigned')
    .sort((a, b) => b.potential_value - a.potential_value)

  const groups = (backendGroups.length ? backendGroups : [...groupMap.values()])
    .filter(g => g.name.trim().toLowerCase() !== 'unassigned')
    .sort((a, b) => b.potential_value - a.potential_value)
  return {
    summary: {
      total_kams: kams.length,
      groups: groups.length,
      total_leads: kams.reduce((sum, k) => sum + k.leads_total, 0),
      total_tenders: kams.reduce((sum, k) => sum + k.tenders_total, 0),
    },
    kams,
    groups,
    charts: {},
    filters: {
      groups: groups.map(g => g.name),
      owners: kams.map(k => ({ id: k.id, name: k.name })),
    },
  }
}

// ─── Score bar ────────────────────────────────────────────────────────────────
function ScoreBar({ score }: { score: number }) {
  const cls = score >= 70 ? 'bg-emerald-500' : score >= 45 ? 'bg-amber-500' : 'bg-red-500'
  const txt = score >= 70 ? 'text-emerald-700' : score >= 45 ? 'text-amber-700' : 'text-red-700'
  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full transition-all duration-700 ${cls}`} style={{ width: `${score}%` }} />
      </div>
      <span className={`font-mono text-[11px] font-bold tabular-nums ${txt}`}>{score}</span>
    </div>
  )
}

// ─── Group KPI card ───────────────────────────────────────────────────────────
function GroupCard({ g, rank }: { g: GroupRow; rank: number }) {
  const { label: customerLabel } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: tenderLabel } = useModuleName('tenders')
  const activeLeadCount = num(g.active_leads_count ?? g.leads_total)
  const activeLeadValue = num(g.active_lead_value ?? g.lead_value)
  const activeTenderCount = num(g.active_tenders_count ?? g.tenders_total)
  const activeTenderValue = num(g.active_tender_value ?? g.tender_value)
  const wonCount = num(g.won_count ?? g.tenders_won)
  const wonValue = num(g.won_pipeline_value ?? g.won_value)
  return (
    <div className="overflow-hidden rounded-xl border border-[#e6eaf1] bg-white shadow-[0_4px_14px_rgba(15,23,42,0.045)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 font-mono text-[10.5px] font-bold text-indigo-700">
            #{rank}
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-slate-900 max-w-[160px] truncate">{g.name}</div>
            <div className="text-[10px] text-slate-500">{g.members} member{g.members !== 1 ? 's' : ''}</div>
          </div>
        </div>
        <div className="min-w-[110px] text-right">
          <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-400">Potential</div>
          <div className="text-[13px] font-bold tabular-nums text-indigo-700">{fmtRsL(g.potential_value)}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-slate-100 text-center">
        {[
          { l: customerLabel, v: fmtN(g.customers_total), val: null, s: `${pct(g.customers_active, g.customers_total || 1)}% active` },
          { l: leadLabel,     v: fmtN(activeLeadCount),   val: fmtRsL(activeLeadValue), s: 'open' },
          { l: tenderLabel,   v: fmtN(activeTenderCount), val: fmtRsL(activeTenderValue), s: 'open' },
          { l: 'Won',         v: fmtN(wonCount),          val: fmtRsL(wonValue), s: 'awarded' },
        ].map(({ l, v, val, s }) => (
          <div key={l} className="px-2 py-2.5">
            <div className="text-[8.5px] font-bold uppercase tracking-[0.08em] text-slate-400">{l}</div>
            <div className="mt-0.5 text-[14px] font-bold tabular-nums text-slate-900">{v}</div>
            {val != null && <div className="text-[9.5px] font-semibold tabular-nums text-indigo-600">{val}</div>}
            <div className="mt-0.5 text-[10px] text-slate-500">{s}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Compact pipeline KPI card ────────────────────────────────────────────────
function PipelineKpiCard({ value, count, sub }: { value: string; count: number; sub: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#d7def0] bg-white px-[18px] pb-4 pt-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
      <span className="absolute inset-x-0 top-0 h-[3px] rounded-t-2xl bg-gradient-to-r from-indigo-700 to-indigo-500" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-500">
          <span className="inline-block h-[5px] w-[5px] rounded-full bg-slate-300" />
          Active Pipeline
        </div>
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-indigo-700">
          {fmtN(count)}
        </span>
      </div>
      <div className="mt-3 text-[24px] font-bold leading-none tracking-tight tabular-nums text-slate-900">
        {value}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2.5 text-[11px] leading-snug text-slate-500">
        <span className="truncate">{sub}</span>
      </div>
    </div>
  )
}

// ─── Group comparison table ───────────────────────────────────────────────────
function GroupComparisonTable({ groups }: { groups: GroupRow[] }) {
  const { label: customerLabel, singular: customerSingular } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: tenderLabel } = useModuleName('tenders')
  if (!groups.length) return null
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="border-b border-slate-200/60 px-5 py-3.5">
        <div className="text-[13px] font-semibold text-slate-900">Group / team comparison</div>
        <div className="mt-0.5 text-[11px] text-slate-500">All metrics side-by-side · {groups.length} groups</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">Group</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Members</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">{customerLabel}</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Active {customerSingular}</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Open {leadLabel}</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">{leadLabel} ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Open {tenderLabel}</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">{tenderLabel} ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Won</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Won ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Potential Value ₹</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g, i) => {
              const activeLeadCount = num(g.active_leads_count ?? g.leads_total)
              const activeLeadValue = num(g.active_lead_value ?? g.lead_value)
              const activeTenderCount = num(g.active_tenders_count ?? g.tenders_total)
              const activeTenderValue = num(g.active_tender_value ?? g.tender_value)
              const wonCount = num(g.won_count ?? g.tenders_won)
              const wonValue = num(g.won_pipeline_value ?? g.won_value)
              return (
                <tr key={i} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-2.5 font-semibold text-slate-900">
                    <div className="max-w-[200px] truncate">{g.name}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-slate-700">{fmtN(g.members)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">{fmtN(g.customers_total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700">{fmtN(g.customers_active)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">{fmtN(activeLeadCount)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono text-blue-700">{fmtRsL(activeLeadValue)}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-slate-900">{fmtN(activeTenderCount)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono text-amber-700">{fmtRsL(activeTenderValue)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700">{fmtN(wonCount)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono text-emerald-700">{fmtRsL(wonValue)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-mono text-indigo-700">{fmtRsL(g.potential_value)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Shared customer drilldown hook ──────────────────────────────────────────
function useCustomerDrilldown(activeFilters?: FilterState) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [custCache, setCustCache] = useState<Record<number, CustomerRow[]>>({})
  const [loadingId, setLoadingId] = useState<number | null>(null)
  const dateFrom = activeFilters?.date_from || ''
  const dateTo = activeFilters?.date_to || ''

  useEffect(() => {
    setExpandedId(null)
    setCustCache({})
  }, [dateFrom, dateTo])

  const toggle = useCallback(async (kamId: number) => {
    if (expandedId === kamId) {
      setExpandedId(null)
      return
    }
    setExpandedId(kamId)
    if (custCache[kamId] !== undefined) return
    setLoadingId(kamId)
    try {
      const params = new URLSearchParams({ user_id: String(kamId), own_only: 'true' })
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      const res = await api.get<CustomerRow[]>(`/kam/plan-customers?${params.toString()}`)
      setCustCache(prev => ({ ...prev, [kamId]: Array.isArray(res.data) ? res.data : [] }))
    } catch {
      setCustCache(prev => ({ ...prev, [kamId]: [] }))
    } finally {
      setLoadingId(null)
    }
  }, [custCache, dateFrom, dateTo, expandedId])

  return { expandedId, custCache, loadingId, toggle }
}

// ─── Customer sub-table ───────────────────────────────────────────────────────
// Columns: Customer | Vertical | Lead ₹ | Tender ₹ | Won ₹
// Removed: Status, Contrib % (no horizontal scroll needed)
function CustomerSubTable({ customers, target }: { customers: CustomerRow[]; target: number }) {
  const { singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { singular: leadSingular } = useModuleName('leads')
  const { singular: tenderSingular } = useModuleName('tenders')
  if (!customers.length) return (
    <div className="py-4 text-center text-[11px] text-slate-400">No {customerLabelLower} found</div>
  )

  const totalWon = customers.reduce((s, c) => s + (c.won_value || 0), 0)

  const ranked = [...customers].sort((a, b) => {
    const aWon = (a.won_count || 0) > 0 || (a.won_value || 0) > 0
    const bWon = (b.won_count || 0) > 0 || (b.won_value || 0) > 0
    const aPipe = (a.tender_count || 0) > 0 || (a.lead_count || 0) > 0 || (a.tender_value || 0) > 0 || (a.lead_value || 0) > 0 || (a.activity_count || 0) > 0
    const bPipe = (b.tender_count || 0) > 0 || (b.lead_count || 0) > 0 || (b.tender_value || 0) > 0 || (b.lead_value || 0) > 0 || (b.activity_count || 0) > 0
    const aRank = aWon ? 0 : aPipe ? 1 : 2
    const bRank = bWon ? 0 : bPipe ? 1 : 2
    if (aRank !== bRank) return aRank - bRank
    return (((b.won_count || 0) * 1000000000) + (b.won_value || 0) + ((b.tender_count || 0) * 1000000) + ((b.lead_count || 0) * 10000) + (b.activity_count || 0))
      - (((a.won_count || 0) * 1000000000) + (a.won_value || 0) + ((a.tender_count || 0) * 1000000) + ((a.lead_count || 0) * 10000) + (a.activity_count || 0))
  })

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="bg-slate-100/70 text-[9.5px] font-bold uppercase tracking-[0.1em] text-slate-500">
            <th className="px-3 py-2 text-left">{customerSingular}</th>
            <th className="px-3 py-2 text-left">Vertical</th>
            <th className="px-3 py-2 text-right text-blue-700">{leadSingular} ₹</th>
            <th className="px-3 py-2 text-right text-amber-700">{tenderSingular} ₹</th>
            <th className="px-3 py-2 text-right text-emerald-700">Won ₹</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((c, i) => {
            const isWon     = (c.won_count || 0) > 0 || (c.won_value || 0) > 0
            const isPipe    = !isWon && ((c.tender_count || 0) > 0 || (c.lead_count || 0) > 0 || (c.tender_value || 0) > 0 || (c.lead_value || 0) > 0 || (c.activity_count || 0) > 0)
            const isNoAct   = !isWon && !isPipe
            const border    = isWon ? '#34d399' : isPipe ? '#fbbf24' : '#fca5a5'
            const bg        = isWon ? '#f0fdf4' : isPipe ? '#fffbeb' : '#fff5f5'
            const nameCls   = isNoAct ? 'text-red-600' : 'text-slate-900'
            const cityCls   = isNoAct ? 'text-red-400' : 'text-slate-400'
            const vertCls   = isNoAct ? 'text-red-400' : 'text-slate-500'
            return (
              <tr
                key={c.id ?? i}
                style={{ borderLeft: `3px solid ${border}`, background: bg }}
                className="border-b border-slate-100 last:border-b-0"
              >
                <td className="px-3 py-2 font-semibold text-slate-900">
                  <div className={`max-w-[240px] truncate font-semibold ${nameCls}`} title={c.customer_name}>{c.customer_name}</div>
                  {c.city && <div className={`text-[9.5px] ${cityCls}`}>{c.city}</div>}
                </td>
                <td className={`px-3 py-2 text-[10px] ${vertCls}`}>{c.vertical || '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-blue-700">
                  {(c.lead_value || 0) > 0 ? fmtRsL(c.lead_value) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-amber-700">
                  {(c.tender_value || 0) > 0 ? fmtRsL(c.tender_value) : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-700">
                  {(c.won_value || 0) > 0 ? fmtRsL(c.won_value) : <span className="text-slate-300">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
        {totalWon > 0 && (
          <tfoot>
            <tr className="border-t border-slate-200 bg-slate-50">
              <td colSpan={4} className="px-3 py-2 text-right text-[10.5px] font-semibold text-slate-600">
                Total won:
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-bold text-emerald-700">
                {fmtRsL(totalWon)}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

// ─── Customer drilldown panel (used in both scorecard + sales perf tables) ────
// Removed summary KPI cards — CustomerSubTable alone is sufficient
function CustomerDrilldownPanel({ kam, customers }: { kam: KAMRow; customers: CustomerRow[] }) {
  return (
    <CustomerSubTable customers={customers} target={kam.sales_target || 0} />
  )
}

function CustomerDrilldownLoading() {
  const { labelLower: customerLabelLower } = useModuleName('customers')
  return (
    <div className="flex items-center justify-center gap-2 py-5 text-[11px] text-slate-500">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-500" />
      Loading {customerLabelLower}…
    </div>
  )
}

// ─── KAM Scorecard table ──────────────────────────────────────────────────────
// Removed Conv %, Win %, Ach % columns → fits without horizontal scroll
function KAMScorecardTable({ kams, filters }: { kams: KAMRow[]; filters?: FilterState }) {
  const { singular } = useModuleName('kam')
  const { singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: travelLabel } = useModuleName('travel')
  const [sortKey, setSortKey] = useState<keyof KAMRow>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const { expandedId, custCache, loadingId, toggle } = useCustomerDrilldown(filters)

  const sorted = useMemo(() => {
    return [...kams].sort((a, b) => {
      const av = num(a[sortKey] ?? 0)
      const bv = num(b[sortKey] ?? 0)
      return sortDir === 'desc' ? bv - av : av - bv
    })
  }, [kams, sortKey, sortDir])

  const toggleSort = (k: keyof KAMRow) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }

  if (!kams.length) return null

  // Total columns = chevron(1) + KAM(1) + Group(1) + Cust(1) + Active(1) +
  //                 Leads(1) + Converted(1) + Lost(1) + Pipeline(1) +
  //                 Tenders(1) + Won(1) + Travel(1) + EMD/BG(1) + Score(1) +
  //                 Target(1) + Won ₹(1) = 16
  const TOTAL_COLS = 16

  const th = (label: string, k: keyof KAMRow, cls = '') => (
    <th
      onClick={() => toggleSort(k)}
      className={`cursor-pointer select-none border-b border-slate-200 px-3 py-2.5 text-[10px] font-bold uppercase tracking-[0.09em] text-slate-500 hover:text-slate-900 transition-colors whitespace-nowrap ${cls}`}
    >
      {label}
      {sortKey === k && <span className="ml-1 text-indigo-600">{sortDir === 'desc' ? '↓' : '↑'}</span>}
    </th>
  )

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="border-b border-slate-200/60 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Star size={14} className="text-amber-500" />
          <span className="text-[13px] font-semibold text-slate-900">{singular} scorecard</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-500">
          360° performance across all modules · click column header to sort · click row to view {customerLabelLower} · {kams.length} {singular}s
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="bg-slate-50/80">
              {/* expand toggle */}
              <th className="border-b border-slate-200 w-8 px-2 py-2.5" />
              {/* KAM name */}
              <th className="border-b border-slate-200 px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.09em] text-slate-500 whitespace-nowrap">
                {singular}
              </th>
              {/* Group */}
              <th className="border-b border-slate-200 px-3 py-2.5 text-left text-[10px] font-bold uppercase tracking-[0.09em] text-slate-500">
                Group
              </th>
              {th(customerSingular, 'customers_total',  'text-right')}
              {th('Active',    'customers_active', 'text-right text-emerald-700')}
              {th(leadLabel,   'leads_total',      'text-right')}
              {th('Converted', 'leads_converted',  'text-right text-emerald-700')}
              {th('Lost',      'leads_lost',       'text-right text-red-600')}
              {th('Pipeline',  'leads_pipeline',   'text-right')}
              {th(tenderLabel, 'tenders_total',    'text-right')}
              {th('Won',       'tenders_won',      'text-right text-emerald-700')}
              {th(travelLabel, 'travel_total',     'text-right')}
              {th('EMD/BG',    'emdbg_active',     'text-right')}
              {th('Score',     'score',            'text-right')}
              {th('Target ₹', 'sales_target',     'text-right')}
              {th('Won ₹',    'won_tender_value',  'text-right')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((k, i) => {
              const score      = k.score ?? calcScore(k)
              const isExpanded = expandedId === k.id
              const isLoading  = loadingId  === k.id

              return (
                <Fragment key={k.id ?? i}>
                  {/* ── main row ── */}
                  <tr
                    className={`border-b border-slate-100 transition-colors ${
                      isExpanded ? 'bg-indigo-50/40' : 'hover:bg-slate-50/60'
                    }`}
                  >
                    {/* chevron */}
                    <td className="px-2 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={() => toggle(k.id)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white hover:text-slate-700"
                        aria-label={isExpanded ? `Collapse ${k.name}` : `Expand ${k.name}`}
                      >
                        <ChevronRight
                          size={12}
                          className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                        />
                      </button>
                    </td>

                    {/* KAM name + hint */}
                    <td className="px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggle(k.id)}
                        className="flex w-full items-center gap-2 text-left"
                      >
                        <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">
                          {(k.name || '?').charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <div
                            className="max-w-[130px] truncate font-semibold text-slate-900"
                            title={k.name}
                          >
                            {k.name}
                          </div>
                          <div className="text-[10px] text-slate-400">
                            {isExpanded ? `Hide ${customerLabelLower}` : `View ${customerLabelLower}`}
                          </div>
                        </div>
                      </button>
                    </td>

                    {/* Group */}
                    <td className="px-3 py-2.5 max-w-[120px]">
                      <div className="truncate text-[11px] text-slate-600" title={k.group}>
                        {k.group || '—'}
                      </div>
                    </td>

                    {/* Cust */}
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">
                      {fmtN(k.customers_total)}
                    </td>
                    {/* Active */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">
                      {fmtN(k.customers_active)}
                    </td>
                    {/* Leads */}
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">
                      {fmtN(k.leads_total)}
                    </td>
                    {/* Converted */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">
                      {fmtN(k.leads_converted)}
                    </td>
                    {/* Lost */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-red-600">
                      {fmtN(k.leads_lost)}
                    </td>
                    {/* Pipeline */}
                    <td className="px-3 py-2.5 text-right tabular-nums font-mono text-indigo-700">
                      {fmtRsL(k.leads_pipeline)}
                    </td>
                    {/* Tenders */}
                    <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-slate-900">
                      {fmtN(k.tenders_total)}
                    </td>
                    {/* Won tenders */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">
                      {fmtN(k.tenders_won)}
                    </td>
                    {/* Travel */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {fmtN(k.travel_total)}
                    </td>
                    {/* EMD/BG */}
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">
                      {fmtN(k.emdbg_active)}
                    </td>
                    {/* Score bar */}
                    <td className="px-3 py-2.5 text-right">
                      <ScoreBar score={score} />
                    </td>
                    {/* Target ₹ */}
                    <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[11px] text-slate-500">
                      {(k.sales_target || 0) > 0
                        ? fmtRsL(k.sales_target!)
                        : <span className="text-slate-300">—</span>}
                    </td>
                    {/* Won ₹ */}
                    <td className="px-3 py-2.5 text-right tabular-nums font-mono text-[11px] text-emerald-700">
                      {(k.won_tender_value || 0) > 0
                        ? fmtRsL(k.won_tender_value!)
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>

                  {/* ── expanded customer detail row ── */}
                  {isExpanded && (
                    <tr>
                      <td colSpan={TOTAL_COLS} className="bg-slate-50/60 px-5 py-4">
                        {isLoading
                          ? <CustomerDrilldownLoading />
                          : <CustomerDrilldownPanel kam={k} customers={custCache[k.id] || []} />
                        }
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Leaderboard strip ────────────────────────────────────────────────────────
function Leaderboard({ kams }: { kams: KAMRow[] }) {
  const { label: customerLabel, singularLower: customerSingularLower } = useModuleName('customers')
  if (!kams.length) return null
  const topConv = [...kams].sort((a, b) => (b.leads_converted || 0) - (a.leads_converted || 0)).slice(0, 3)
  const topWon  = [...kams].sort((a, b) => (b.won_tender_value || 0) - (a.won_tender_value || 0)).slice(0, 3)
  const topCust = [...kams].sort((a, b) => (b.customers_with_win || 0) - (a.customers_with_win || 0)).slice(0, 3)
  const topAch  = [...kams]
    .filter(k => (k.sales_target || 0) > 0)
    .sort((a, b) => {
      const ap = (a.won_tender_value || 0) / (a.sales_target || 1)
      const bp = (b.won_tender_value || 0) / (b.sales_target || 1)
      return bp - ap
    }).slice(0, 3)

  const categories = [
    { title: 'Top converters',   icon: TrendingUp, items: topConv, metricFn: (k: KAMRow) => `${fmtN(k.leads_converted)} conv`,               color: 'text-emerald-600' },
    { title: 'Top won value',    icon: Award,      items: topWon,  metricFn: (k: KAMRow) => fmtRsL(k.won_tender_value || 0),                  color: 'text-indigo-600'  },
    { title: `${customerLabel} won`, icon: Users,  items: topCust, metricFn: (k: KAMRow) => `${fmtN(k.customers_with_win || 0)} ${customerSingularLower}`, color: 'text-sky-600' },
    { title: 'Target achievers', icon: Star,       items: topAch,  metricFn: (k: KAMRow) => {
        const p = (k.sales_target || 0) > 0 ? Math.round((k.won_tender_value || 0) / (k.sales_target || 1) * 100) : 0
        return `${p}% of target`
      }, color: 'text-amber-500' },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {categories.map(({ title, icon: Icon, items, metricFn, color }) => (
        <div key={title} className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <Icon size={13} className={color} />
            <span className="text-[12px] font-semibold text-slate-900">{title}</span>
          </div>
          <div className="divide-y divide-slate-100 px-4 py-1">
            {items.map((k, idx) => (
              <div key={idx} className="flex items-center justify-between gap-2 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-[11px] font-black ${idx === 0 ? 'text-amber-500' : 'text-slate-400'}`}>
                    {idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}
                  </span>
                  <div className="min-w-0">
                    <div className="max-w-[120px] truncate text-[12px] font-semibold text-slate-900" title={k.name}>{k.name}</div>
                    <div className="max-w-[120px] truncate text-[10px] text-slate-500">{k.group}</div>
                  </div>
                </div>
                <span className={`whitespace-nowrap text-[12px] font-bold tabular-nums ${color}`}>{metricFn(k)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Group performance charts ─────────────────────────────────────────────────
function GroupRadarChart({ groups }: { groups: GroupRow[] }) {
  const { label: customerLabel } = useModuleName('customers')
  const { label: leadLabel, labelLower: leadLabelLower } = useModuleName('leads')
  const { label: tenderLabel } = useModuleName('tenders')
  if (!groups.length) return null

  const radarData = groups.slice(0, 5).map(g => ({
    group:      g.name.length > 14 ? g.name.slice(0, 14) + '…' : g.name,
    [customerLabel]: g.customers_total,
    [leadLabel]:     g.leads_total,
    Converted:  g.leads_converted,
    'Win Rate': g.tenders_total ? pct(g.tenders_won, g.tenders_total) : 0,
  }))

  const groupBarData = groups.slice(0, 8).map(g => ({
    name:      g.name.length > 18 ? g.name.slice(0, 18) + '…' : g.name,
    [leadLabel]:   g.leads_total,
    Converted: g.leads_converted,
    [tenderLabel]: g.tenders_total,
    Won:       g.tenders_won,
  }))

  return (
    <div className="grid grid-cols-2 gap-4">
      <ChartShell title={`Group ${leadLabelLower} performance`} sub={`Total ${leadLabelLower} vs conversions`} height={260}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={groupBarData} barGap={2} barSize={12} margin={{ top: 8, right: 8, bottom: 0, left: -10 }}>
            <CartesianGrid {...CGRID} />
            <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
            <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
            <Tooltip content={<ChartTip />} />
            <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 9 }} />
            <Bar dataKey={leadLabel} fill={C.primary} radius={[2, 2, 0, 0]} />
            <Bar dataKey="Converted" fill={C.pos}     radius={[2, 2, 0, 0]} />
            <Bar dataKey="Won"       fill={C.warn}    radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartShell>

      <ChartShell title="Top 5 groups — radar" sub={`${customerLabel} · ${leadLabel} · Converted · Win rate`} height={260}>
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={radarData}>
            <PolarGrid stroke="#e6eaf1" />
            <PolarAngleAxis dataKey="group" tick={{ fontSize: 9, fill: C.ink3 }} />
            {radarData.map((g, i) => (
              <Radar
                key={g.group}
                name={g.group}
                dataKey="Converted"
                stroke={CHART[i % CHART.length]}
                fill={CHART[i % CHART.length]}
                fillOpacity={0.08}
              />
            ))}
            <Tooltip content={<ChartTip />} />
          </RadarChart>
        </ResponsiveContainer>
      </ChartShell>
    </div>
  )
}

// ─── Target achievement bars ──────────────────────────────────────────────────
function TargetAchievementBars({ kams }: { kams: KAMRow[] }) {
  const { singular } = useModuleName('kam')
  const { singularLower: customerSingularLower } = useModuleName('customers')
  const withTarget = kams.filter(k => (k.sales_target || 0) > 0)
  if (!withTarget.length) return null

  const sorted = [...withTarget].sort((a, b) => {
    const ap = (a.won_tender_value || 0) / (a.sales_target || 1)
    const bp = (b.won_tender_value || 0) / (b.sales_target || 1)
    return bp - ap
  })

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="border-b border-slate-200/60 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-indigo-600" />
          <span className="text-[13px] font-semibold text-slate-900">Target achievement</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-500">
          Won value vs sales target · {sorted.length} {singular}{sorted.length !== 1 ? 's' : ''} with targets set
        </div>
      </div>
      <div className="divide-y divide-slate-100 px-5 py-1">
        {sorted.map(k => {
          const won    = k.won_tender_value || 0
          const tgt    = k.sales_target || 0
          const rawPct = tgt > 0 ? Math.round(won / tgt * 100) : 0
          const barW   = Math.min(100, rawPct)
          const bar    = rawPct >= 100 ? '#10b981' : rawPct >= 60 ? '#6366f1' : rawPct >= 30 ? '#f59e0b' : '#ef4444'
          const bg     = rawPct >= 100 ? '#f0fdf4' : rawPct >= 60 ? '#eef2ff' : rawPct >= 30 ? '#fffbeb' : '#fff5f5'
          return (
            <div key={k.id} className="flex items-center gap-3 py-2.5">
              <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-bold text-slate-700">
                {(k.name || '?').charAt(0).toUpperCase()}
              </span>
              <div className="w-[110px] flex-shrink-0">
                <div className="truncate text-[12px] font-semibold text-slate-900" title={k.name}>{k.name}</div>
                <div className="truncate text-[10px] text-slate-500">{k.group || '—'}</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${barW}%`, background: bar }} />
                </div>
                <div className="mt-1 flex justify-between text-[10px]">
                  <span style={{ color: bar }} className="font-semibold">{fmtRsL(won)} won</span>
                  <span className="text-slate-400">target {fmtRsL(tgt)}</span>
                </div>
              </div>
              <div className="w-[48px] flex-shrink-0 text-right">
                <span
                  className="inline-flex rounded-lg px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
                  style={{ background: bg, color: bar }}
                >
                  {rawPct}%
                </span>
              </div>
              <div className="w-[50px] flex-shrink-0 text-right text-[10px] text-slate-500">
                <span className="font-semibold text-emerald-600">{fmtN(k.customers_with_win || 0)}</span>
                /{fmtN((k.customers_with_win || 0) + (k.customers_pending || 0))} {customerSingularLower}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Sales performance table (collapsible per-KAM rows) ──────────────────────
function SalesPerformanceTable({ kams, filters }: { kams: KAMRow[]; filters?: FilterState }) {
  const { singular } = useModuleName('kam')
  const { singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { expandedId, custCache, loadingId, toggle } = useCustomerDrilldown(filters)

  const sorted = useMemo(() =>
    [...kams].sort((a, b) => {
      const ap = a.sales_target ? (a.won_tender_value || 0) / a.sales_target : 0
      const bp = b.sales_target ? (b.won_tender_value || 0) / b.sales_target : 0
      return bp - ap
    }), [kams])

  if (!kams.length) return null

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="border-b border-slate-200/60 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Users size={14} className="text-indigo-600" />
          <span className="text-[13px] font-semibold text-slate-900">Sales performance</span>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-500">
          {customerSingular} total · won · target vs achieved · click any row to drill into {customerLabelLower} detail
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="border-b border-slate-200 w-8 px-3 py-2.5" />
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">{singular}</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">Group</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Total {customerSingular}</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">{customerSingular} Won</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-amber-700">{customerSingular} Pending</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Target ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Won ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Achievement</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(k => {
              const achPct  = (k.sales_target || 0) > 0
                ? Math.round((k.won_tender_value || 0) / (k.sales_target || 1) * 100)
                : -1
              const isExp  = expandedId === k.id
              const isLoad = loadingId  === k.id
              const bar     = achPct >= 100 ? '#10b981' : achPct >= 60 ? '#6366f1' : achPct >= 30 ? '#f59e0b' : '#ef4444'
              const badgeBg = achPct >= 100 ? '#f0fdf4' : achPct >= 60 ? '#eef2ff' : achPct >= 30 ? '#fffbeb' : '#fff5f5'

              return (
                <Fragment key={k.id}>
                  <tr
                    onClick={() => toggle(k.id)}
                    className={`cursor-pointer border-b border-slate-100 transition-colors ${isExp ? 'bg-indigo-50/40' : 'hover:bg-slate-50/60'}`}
                  >
                    <td className="px-3 py-3 text-center">
                      <ChevronRight
                        size={12}
                        className={`text-slate-400 transition-transform duration-200 ${isExp ? 'rotate-90' : ''}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-bold text-indigo-700">
                          {(k.name || '?').charAt(0).toUpperCase()}
                        </span>
                        <span className="max-w-[130px] truncate font-semibold text-slate-900" title={k.name}>
                          {k.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 max-w-[120px]">
                      <div className="truncate text-[11px] text-slate-500">{k.group || '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-slate-900">
                      {fmtN(k.customers_total)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold text-emerald-700">
                      {fmtN(k.customers_with_win || 0)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-700">
                      {fmtN(k.customers_pending || 0)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-mono text-[11px] text-slate-500">
                      {(k.sales_target || 0) > 0
                        ? fmtRsL(k.sales_target!)
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-mono text-[11px] font-semibold text-emerald-700">
                      {(k.won_tender_value || 0) > 0
                        ? fmtRsL(k.won_tender_value!)
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {achPct >= 0 ? (
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${Math.min(100, achPct)}%`, background: bar }}
                            />
                          </div>
                          <span
                            className="inline-flex min-w-[36px] justify-center rounded-lg px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                            style={{ background: badgeBg, color: bar }}
                          >
                            {achPct}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>

                  {isExp && (
                    <tr>
                      <td colSpan={9} className="bg-slate-50/60 px-5 py-4">
                        {isLoad
                          ? <CustomerDrilldownLoading />
                          : <CustomerDrilldownPanel kam={k} customers={custCache[k.id] || []} />
                        }
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Target vs Achieved chart ─────────────────────────────────────────────────
function TargetVsAchievedChart({ kams }: { kams: KAMRow[] }) {
  const { singular } = useModuleName('kam')
  const data = useMemo(() => {
    return [...kams]
      .filter(k => (k.sales_target || 0) > 0 || (k.won_tender_value || 0) > 0)
      .sort((a, b) => (b.won_tender_value || 0) - (a.won_tender_value || 0))
      .slice(0, 12)
      .map(k => ({
        name:       k.name.length > 12 ? k.name.slice(0, 12) + '…' : k.name,
        'Target ₹': Math.round((k.sales_target     || 0) / 100000) / 10,
        'Won ₹':    Math.round((k.won_tender_value || 0) / 100000) / 10,
      }))
  }, [kams])

  if (!data.length) return null

  return (
    <ChartShell title="Target vs Won" sub={`Per ${singular} · values in ₹ Lakhs · sorted by won value`} height={280}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} barGap={3} barSize={14} margin={{ top: 8, right: 12, bottom: 0, left: -10 }}>
          <CartesianGrid {...CGRID} />
          <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
          <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={34} tickFormatter={v => `${v}L`} />
          <Tooltip content={<ChartTip />} formatter={(v: any) => [`₹${v}L`, '']} />
          <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 9 }} />
          <Bar dataKey="Target ₹" fill="#6366f1" radius={[3, 3, 0, 0]} fillOpacity={0.6} />
          <Bar dataKey="Won ₹"    fill="#10b981" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartShell>
  )
}

// ─── Empty / error state ──────────────────────────────────────────────────────
function EmptyState({ onRetry }: { onRetry: () => void }) {
  const { label: kamLabel } = useModuleName('kam')
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white py-16 text-center shadow-sm">
      <Compass size={36} className="mb-3 text-slate-300" />
      <p className="text-sm font-semibold text-slate-700">{kamLabel} data not available</p>
      <p className="mt-1 max-w-xs text-xs text-slate-500">
        The {kamLabel} analytics endpoint is not returning data yet. Check if this module is enabled.
      </p>
      <button
        onClick={onRetry}
        className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
      >
        <RefreshCw size={12} /> Retry
      </button>
    </div>
  )
}

// ─── CSV export ───────────────────────────────────────────────────────────────
function exportKAMCSV(kams: KAMRow[]) {
  const headers = 'Name,Group,Region,Customers,Active Cust,Leads,Converted,Conv%,Lost,Overdue,Pipeline,Tenders,Won,Win%,Travel,EMD/BG,Score,Target,Won Value,Ach%'
  const rows = kams.map(k => {
    const score   = k.score ?? calcScore(k)
    const convPct = k.leads_total   ? pct(k.leads_converted, k.leads_total)   : 0
    const winPct  = k.tenders_total ? pct(k.tenders_won,     k.tenders_total) : 0
    const achPct  = (k.sales_target || 0) > 0
      ? Math.round((k.won_tender_value || 0) / (k.sales_target || 1) * 100)
      : ''
    return [
      `"${k.name}"`, `"${k.group}"`, `"${k.region}"`,
      k.customers_total, k.customers_active,
      k.leads_total, k.leads_converted, `${convPct}%`, k.leads_lost, k.leads_overdue, k.leads_pipeline,
      k.tenders_total, k.tenders_won, `${winPct}%`,
      k.travel_total, k.emdbg_active, score,
      k.sales_target || '', k.won_tender_value || '', achPct !== '' ? `${achPct}%` : '',
    ].join(',')
  }).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([headers + '\n' + rows], { type: 'text/csv' }))
  a.download = 'kam360.csv'
  a.click()
}

// ─── Main KAM360Tab ───────────────────────────────────────────────────────────
export default function KAM360Tab() {
  const { label: kamLabel, singular: kamSingular } = useModuleName('kam')
  const { label: customerLabel, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, singular: leadSingular } = useModuleName('leads')
  const { labelLower: tenderLabelLower } = useModuleName('tenders')
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [pending, setPending] = useState<FilterState>(EMPTY_FILTERS)

  const loadData = useCallback(async (f: FilterState) => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v) })
      try {
        const res = await api.get(`/dashboard/tab/kam360?${p}`)
        setData(res.data)
      } catch (err: any) {
        if (err?.response?.status !== 404) throw err
        const fallbackParams = new URLSearchParams()
        if (f.date_from) fallbackParams.set('period', f.date_from.slice(0, 7))
        const fallback = await api.get(`/kam/team-360?${fallbackParams}`)
        setData(fromKamTeam360(fallback.data))
      }
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData(EMPTY_FILTERS) }, [loadData])

  const handleApply = () => { setFilters(pending); loadData(pending) }
  const handleReset = () => { setFilters(EMPTY_FILTERS); setPending(EMPTY_FILTERS); loadData(EMPTY_FILTERS) }

  if (loading && !data) return <TabSkeleton />

  const s: any         = data?.summary || {}
  const kams: KAMRow[] = data?.kams    || []
  const groups: GroupRow[] = data?.groups || []
  const charts: any    = data?.charts  || {}

  const totalKAMs    = num(s.total_kams || kams.length)
  const groupPipelineValue = groups.reduce((sum, g) => sum + num(g.active_pipeline_value ?? g.pipeline), 0)
  const groupPipelineCount = groups.reduce((sum, g) => sum + num(g.active_pipeline_count ?? (num(g.active_leads_count ?? g.leads_total) + num(g.active_tenders_count ?? g.tenders_total))), 0)
  const totalPipeline = s.active_pipeline_value != null
    ? num(s.active_pipeline_value)
    : groupPipelineValue || num(s.pipeline_value) || kams.reduce((sum, k) => sum + num(k.leads_pipeline), 0)
  const totalPipelineCount = s.active_pipeline_count != null
    ? num(s.active_pipeline_count)
    : groupPipelineCount

  const totalSalesTarget      = num(s.total_sales_target)       || kams.reduce((sum, k) => sum + num(k.sales_target      ?? 0), 0)
  const totalWonValue         = num(s.total_won_value)          || kams.reduce((sum, k) => sum + num(k.won_tender_value  ?? 0), 0)
  const totalCustomersWithWin = num(s.total_customers_with_win) || kams.reduce((sum, k) => sum + num(k.customers_with_win ?? 0), 0)
  const teamAchPct = totalSalesTarget > 0 ? Math.round(totalWonValue / totalSalesTarget * 100) : 0

  const monthlyActivity: any[] = charts.monthly_activity || []

  return (
    <div className="space-y-5 p-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between rounded-2xl border border-[#e6eaf1] bg-gradient-to-b from-white to-slate-50/40 px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm text-slate-700">
            <Compass size={20} />
          </div>
          <div>
            <h1 className="m-0 text-[16px] font-bold tracking-tight text-slate-900">{kamLabel}°</h1>
            <div className="mt-0.5 text-[11px] font-medium text-slate-500">
              Key Account Manager analytics · cross-module performance
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          {[
            { label: `${kamSingular}s`, value: fmtN(totalKAMs) },
            { label: 'Won Value', value: fmtRsL(totalWonValue) },
            { label: 'vs Target', value: fmtRsL(totalSalesTarget) },
            { label: 'Achieved',  value: totalSalesTarget > 0 ? `${teamAchPct}%` : '—' },
          ].map(({ label, value }) => (
            <div key={label} className="text-center">
              <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</div>
              <div className="mt-0.5 text-[20px] font-bold tabular-nums text-slate-900">{value}</div>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          {kams.length > 0 && (
            <button
              onClick={() => exportKAMCSV(kams)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-400 transition-all"
            >
              <Download size={12} /> Export
            </button>
          )}
          <button
            onClick={() => loadData(filters)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-400 transition-all disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* ── Filter strip ── */}
      <div className="flex flex-wrap items-end gap-3 overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white px-5 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        {[
          { label: 'From date', key: 'date_from' as keyof FilterState, type: 'date' },
          { label: 'To date',   key: 'date_to'   as keyof FilterState, type: 'date' },
        ].map(({ label, key, type }) => (
          <div key={key} className="flex flex-col gap-1">
            <label className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">{label}</label>
            <input
              type={type}
              value={pending[key]}
              onChange={e => setPending(p => ({ ...p, [key]: e.target.value }))}
              className="min-w-[140px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-900 outline-none transition-all focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100"
            />
          </div>
        ))}
        {(data?.filters?.groups || []).length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">Group</label>
            <select
              value={pending.group}
              onChange={e => setPending(p => ({ ...p, group: e.target.value }))}
              className="min-w-[140px] rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-900 outline-none"
            >
              <option value="">All groups</option>
              {(data?.filters?.groups || []).map((g: string) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
        )}
        <button
          onClick={handleApply}
          disabled={loading}
          className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-slate-900 bg-slate-900 px-5 text-xs font-semibold text-white shadow-sm hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {loading && (
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          )}
          Apply
        </button>
        {Object.values(pending).some(v => v !== '') && (
          <button
            onClick={handleReset}
            className="text-[11px] text-slate-500 hover:text-red-600 transition-colors"
          >
            ✕ Clear
          </button>
        )}
      </div>

      {/* ── Empty state ── */}
      {!loading && !kams.length && <EmptyState onRetry={() => loadData(filters)} />}

      {kams.length > 0 && (
        <>
          {/* 01 KPI cards */}
          <Section idx="01" title="Team overview" />
          <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
            <KpiCard
              label="Team Achievement"
              value={totalSalesTarget > 0 ? `${teamAchPct}%` : '—'}
              tone={teamAchPct >= 100 ? 'pos' : teamAchPct >= 60 ? 'info' : teamAchPct >= 30 ? 'warn' : 'neg'}
              alert={totalSalesTarget > 0 && teamAchPct < 30}
              sub={totalSalesTarget > 0 ? `${fmtRsL(totalWonValue)} of ${fmtRsL(totalSalesTarget)}` : 'no targets set'}
            />
            <KpiCard label="Won Value" value={fmtRsL(totalWonValue)} tone="pos" sub={`${tenderLabelLower} wins this period`} />
            <KpiCard
              label={`${customerLabel} Won`}
              value={fmtN(totalCustomersWithWin)}
              spotlight
              sub={`of ${fmtN(num(s.total_customers) || kams.reduce((s, k) => s + k.customers_total, 0))} total ${customerLabelLower}`}
            />
            <PipelineKpiCard
              value={fmtRsL(totalPipeline)}
              count={totalPipelineCount}
              sub={`open ${leadSingular.toLowerCase()} and ${tenderLabelLower} value`}
            />
          </div>

          {/* 02 Group performance */}
          {groups.length > 0 && (
            <>
              <Section idx="02" title="Group performance" desc={`${groups.length} groups`} />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {groups.slice(0, 4).map((g, i) => <GroupCard key={g.name} g={g} rank={i + 1} />)}
              </div>
              <GroupComparisonTable groups={groups} />
            </>
          )}

          {/* 03 KAM Scorecard */}
          <Section idx="03" title={`${kamSingular} scorecard`} desc={`360° view · sort columns · click row to expand ${customerLabelLower} detail`} />
          <KAMScorecardTable kams={kams} filters={filters} />

          {/* 04 Leaderboard */}
          <Section idx="04" title="Leaderboard" desc="Top performers by category" />
          <Leaderboard kams={kams} />

          {/* 05 Target achievement */}
          <Section idx="05" title="Target achievement" desc="Individual won value vs sales target" />
          <TargetAchievementBars kams={kams} />

          {/* 06 Sales performance */}
          <Section idx="06" title="Sales performance" desc={`Per-${kamSingular} breakdown · click to expand ${customerLabelLower} detail`} />
          <TargetVsAchievedChart kams={kams} />
          <SalesPerformanceTable kams={kams} filters={filters} />

          {/* 07 Charts */}
          <Section idx="07" title="Performance charts" />
          <GroupRadarChart groups={groups} />

          {/* Monthly activity trend */}
          {monthlyActivity.length > 0 && (
            <ChartShell title="Monthly activity trend" sub={`${leadLabel} · conversions · ${tenderLabelLower} (team total)`} height={240}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={monthlyActivity} margin={{ top: 8, right: 12, bottom: 0, left: -10 }}>
                  <defs>
                    <linearGradient id="kamLd" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.primary} stopOpacity={0.15} />
                      <stop offset="100%" stopColor={C.primary} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="kamConv" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.pos} stopOpacity={0.15} />
                      <stop offset="100%" stopColor={C.pos} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...CGRID} />
                  <XAxis dataKey="month" tick={AXIS_X} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
                  <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
                  <Tooltip content={<ChartTip />} />
                  <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 10 }} />
                  <Area
                    type="monotone" dataKey="leads" name={leadLabel}
                    stroke={C.primary} strokeWidth={2} fill="url(#kamLd)"
                    dot={false} activeDot={{ r: 4 }}
                  />
                  <Area
                    type="monotone" dataKey="converted" name="Converted"
                    stroke={C.pos} strokeWidth={2} fill="url(#kamConv)"
                    dot={false} activeDot={{ r: 4 }}
                  />
                  <Area
                    type="monotone" dataKey="tenders" name={tenderLabelLower}
                    stroke={C.warn} strokeWidth={2} fill="transparent"
                    dot={false} activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartShell>
          )}

          {/* Overdue alerts */}
          {kams.some(k => k.leads_overdue > 0) && (
            <div className="overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/60">
              <div className="flex items-center gap-2.5 border-b border-amber-200/60 px-5 py-3">
                <AlertCircle size={14} className="text-amber-700" />
                <span className="text-[12px] font-semibold text-amber-900">{kamSingular}s with overdue follow-ups</span>
              </div>
              <div className="flex flex-wrap gap-2 px-5 py-3">
                {kams
                  .filter(k => k.leads_overdue > 0)
                  .sort((a, b) => b.leads_overdue - a.leads_overdue)
                  .map(k => (
                    <div
                      key={k.id ?? k.name}
                      className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 shadow-sm"
                    >
                      <span className="text-[12px] font-semibold text-slate-900">{k.name}</span>
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[10px] font-bold text-amber-700">
                        {k.leads_overdue} overdue
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
