/**
 * KAMReportView.tsx — KAM 360 Analytics report (Reports section).
 * Data source: GET /reports/kam + /reports/kam/filter-options (reports_router.py).
 * Enterprise analytics layout: command-center KPI card + engagement-insight story card,
 * activity trend + upcoming-actions timeline, KAM leaderboard / activity mix /
 * account intervention queue, and a full activity register table.
 * Everything is computed client-side from the in-memory rows so global search
 * filters all widgets consistently.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AreaChart, Area, CartesianGrid, XAxis, YAxis } from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, CHART, fmtN, num, pct, ChartTip, Badge, KpiCard, ChartShell, TopList,
  Section, TabSkeleton, StatsRow, ColDef, AXIS_X, AXIS_Y, CGRID, Tooltip, ResponsiveContainer, exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import { TimelineChart } from '../dashboard/tabs/_analyticsCharts'
import { AnalyticsFilterBar, AnalyticsFilterState, EMPTY_ANALYTICS_FILTERS } from './shared/AnalyticsFilterBar'
import { ListDrilldownModal, ListDrilldownRequest } from './shared/ListDrilldownModal'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

// Server-side filters supported by GET /reports/kam; search stays client-side.
function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()
  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.owner) p.set('user_id', f.owner)
  if (f.status) p.set('status', f.status)
  if (f.customer_id) p.set('customer_id', f.customer_id)
  p.set('per_page', '1000')
  return p
}
const SERVER_KEYS: (keyof AnalyticsFilterState)[] = ['date_from', 'date_to', 'owner', 'status', 'customer_id']

export default function KAMReportView() {
  const { label: kamLabel, singular: kamSingular, labelLower: kamLabelLower } = useModuleName('kam')
  const { singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: travelLabel, labelLower: travelLabelLower } = useModuleName('travel')
  const [rows, setRows] = useState<any[]>([])
  const [options, setOptions] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const initialGlobalRange = useInitialGlobalDateRange()
  const [filters, setFilters] = useState<AnalyticsFilterState>(() => ({ ...EMPTY_ANALYTICS_FILTERS, ...initialGlobalRange }))
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const loadData = useCallback(async (f: AnalyticsFilterState) => {
    setLoading(true)
    try {
      const res = await api.get(`/reports/kam?${toBackendParams(f)}`)
      setRows(res.data?.data || [])
    } catch { setRows([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    loadData(filters)
    api.get('/reports/kam/filter-options')
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
    return rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)))
  }, [rows, filters.search])

  // ── Derived metrics ──────────────────────────────────────────────────────────
  const completedRows = useMemo(() => tableRows.filter(r => r.status === 'Completed'), [tableRows])
  const completedCount = completedRows.length
  const completedRate = pct(completedCount, tableRows.length)
  const overdueRows = useMemo(() => tableRows.filter(r => r.is_overdue === 'Yes'), [tableRows])
  const uniqueCustomers = useMemo(() =>
    new Set(tableRows.map(r => r.customer_name).filter(Boolean)).size, [tableRows])
  const upcoming7 = useMemo(() =>
    tableRows.filter(r => r.days_to_next != null && num(r.days_to_next) >= 0 && num(r.days_to_next) <= 7)
      .sort((a, b) => num(a.days_to_next) - num(b.days_to_next)), [tableRows])
  const travelLinkedRows = useMemo(() => tableRows.filter(r => r.has_travel === 'Yes'), [tableRows])
  const travelLinkedShare = pct(travelLinkedRows.length, tableRows.length)
  const cancelledRows = useMemo(() => tableRows.filter(r => r.status === 'Cancelled'), [tableRows])
  const cancelled = cancelledRows.length
  const durationRows = useMemo(() => tableRows.filter(r => num(r.duration_minutes) > 0), [tableRows])
  const avgDuration = useMemo(() => {
    const durations = durationRows.map(r => num(r.duration_minutes))
    return durations.length ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : 0
  }, [durationRows])

  // Account engagement map → at-risk accounts (stale >30 days or with overdue follow-ups)
  const accounts = useMemo(() => {
    const m: Record<string, { count: number; completed: number; lastDate: string; overdue: number }> = {}
    tableRows.forEach(r => {
      const c = r.customer_name || 'Unknown'
      if (!m[c]) m[c] = { count: 0, completed: 0, lastDate: '', overdue: 0 }
      m[c].count++
      if (r.status === 'Completed') m[c].completed++
      if (r.is_overdue === 'Yes') m[c].overdue++
      if (r.activity_date && r.activity_date > m[c].lastDate) m[c].lastDate = r.activity_date
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v }))
  }, [tableRows])

  const atRisk = useMemo(() => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    return accounts
      .filter(a => a.overdue > 0 || (a.lastDate && a.lastDate < cutoff))
      .sort((a, b) => b.overdue - a.overdue || a.lastDate.localeCompare(b.lastDate))
  }, [accounts])

  // Monthly activity trend (last 12 months by activity_date)
  const monthlyTrend = useMemo(() => {
    const m: Record<string, { count: number; completed: number }> = {}
    tableRows.forEach(r => {
      const key = (r.activity_date || '').slice(0, 7)
      if (!key) return
      if (!m[key]) m[key] = { count: 0, completed: 0 }
      m[key].count++
      if (r.status === 'Completed') m[key].completed++
    })
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, v]) => ({ month, ...v }))
  }, [tableRows])

  const leaderboard = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const u = r.user || 'Unknown'
      m[u] = (m[u] || 0) + 1
    })
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }, [tableRows])

  const typeMix = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const t = r.activity_type || 'Other'
      m[t] = (m[t] || 0) + 1
    })
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6)
  }, [tableRows])

  const cols: ColDef[] = [
    { key: 'activity_date', label: 'Date', render: v => <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span> },
    { key: 'user', label: 'KAM', render: v => <span className="font-semibold text-slate-900">{v || '—'}</span> },
    { key: 'customer_name', label: customerSingular },
    { key: 'activity_type', label: 'Type' },
    { key: 'subject', label: 'Subject', render: v => <span className="truncate max-w-[220px] block">{v || '—'}</span> },
    { key: 'status', label: 'Status', render: v => v ? <Badge text={v} /> : null },
    { key: 'mode', label: 'Mode' },
    { key: 'duration_minutes', label: 'Duration', align: 'right', render: v => `${num(v)}m` },
    { key: 'next_action_date', label: 'Next Action', render: v => <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span> },
    { key: 'is_overdue', label: 'Overdue', render: v => v === 'Yes' ? <Badge text="Overdue" tone="neg" /> : <span className="text-slate-300">—</span> },
    { key: 'has_travel', label: travelLabel },
  ]

  const openList = (title: string, sub: string, list: any[]) => {
    setListDrill({ title, sub, rows: list, columns: cols })
  }

  if (loading && !rows.length) return <TabSkeleton />

  return (
    <div className="space-y-4">

      <AnalyticsFilterBar
        filters={filters} onChange={handleChange} onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() => exportRows(tableRows, cols, 'kam_activities')}
        filterOptions={{
          owners: options?.users, statuses: options?.statuses, customers: options?.customers,
        }}
        loading={loading}
      />

      {/* ROW 1 — command center + engagement insight */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.25fr_.75fr] gap-4">
        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-violet-600">{kamLabel} strategic account analytics</p>
          <h3 className="mt-1 text-lg font-black tracking-tight text-slate-900">Account health, engagement depth and relationship strength</h3>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 mt-4">
            <KpiCard label="Total Activities" value={fmtN(tableRows.length)} tone="primary" sub={`${fmtN(uniqueCustomers)} ${customerLabelLower} engaged`}
              onClick={() => openList('Total Activities', `All ${kamLabel} activities in view`, tableRows)} />
            <KpiCard label="Completion Rate" value={`${completedRate}%`} tone="pos" sub={`${fmtN(completedCount)} completed`}
              onClick={() => openList('Completed Activities', 'Activities with status Completed', completedRows)} />
            <KpiCard label="Overdue Follow-ups" value={fmtN(overdueRows.length)} tone="neg" alert={overdueRows.length > 0} sub="Need immediate action"
              onClick={() => openList('Overdue Follow-ups', 'Activities needing immediate action', overdueRows)} />
            <KpiCard label={`${travelLabel}-Linked`} value={`${travelLinkedShare}%`} tone="info" sub={`activities with ${travelLabelLower}`}
              onClick={() => openList(`${travelLabel}-Linked Activities`, `Activities linked to ${travelLabelLower}`, travelLinkedRows)} />
          </div>
        </div>

        <div className="rounded-2xl border border-[#e6eaf1] border-l-4 border-l-violet-500 bg-gradient-to-br from-violet-50/40 to-white p-5">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-violet-600">Engagement insight</p>
          <h3 className="mt-1 text-lg font-black tracking-tight text-slate-900">
            {atRisk.length > 0 ? `${fmtN(atRisk.length)} accounts need re-engagement` : 'All engaged accounts are active'}
          </h3>
          <p className="mt-1 text-[12px] text-slate-500">
            Accounts with no activity in 30+ days or overdue follow-ups are flagged for intervention.
          </p>
          <div className="grid grid-cols-3 gap-2 text-center mt-4">
            <div
              onClick={() => openList('Overdue Follow-ups', 'Activities needing immediate action', overdueRows)}
              className="cursor-pointer rounded-xl border border-[#e6eaf1] bg-white p-3 transition hover:border-slate-300 hover:shadow-sm"
            >
              <p className="text-lg font-black text-red-600">{fmtN(overdueRows.length)}</p>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">overdue</p>
            </div>
            <div
              onClick={() => openList('Cancelled Activities', 'Activities with status Cancelled', cancelledRows)}
              className="cursor-pointer rounded-xl border border-[#e6eaf1] bg-white p-3 transition hover:border-slate-300 hover:shadow-sm"
            >
              <p className="text-lg font-black text-amber-600">{fmtN(cancelled)}</p>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">cancelled</p>
            </div>
            <div
              onClick={() => openList('Timed Activities', 'Activities with a recorded duration', durationRows)}
              className="cursor-pointer rounded-xl border border-[#e6eaf1] bg-white p-3 transition hover:border-slate-300 hover:shadow-sm"
            >
              <p className="text-lg font-black text-emerald-600">{avgDuration}m</p>
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">avg duration</p>
            </div>
          </div>
        </div>
      </div>

      {/* ROW 2 — activity trend + upcoming actions */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_.8fr] gap-4">
        <ChartShell title="Activity Trend" sub="Total vs completed activities by month" height={290}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={monthlyTrend} margin={{ top: 16, right: 8, bottom: 0, left: -10 }}>
              <defs>
                <linearGradient id="kActGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.primary} stopOpacity={0.25} /><stop offset="95%" stopColor={C.primary} stopOpacity={0.02} /></linearGradient>
                <linearGradient id="kDoneGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.pos} stopOpacity={0.2} /><stop offset="95%" stopColor={C.pos} stopOpacity={0.02} /></linearGradient>
              </defs>
              <CartesianGrid {...CGRID} />
              <XAxis dataKey="month" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
              <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
              <Tooltip content={<ChartTip />} />
              <Area dataKey="count" name="Activities" stroke={C.primary} strokeWidth={2} fill="url(#kActGrad)" dot={false} />
              <Area dataKey="completed" name="Completed" stroke={C.pos} strokeWidth={2} fill="url(#kDoneGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartShell>

        <TimelineChart title="Upcoming Actions" sub="Next 7 days" height={290}
          items={upcoming7.map(r => ({
            date: r.next_action_date,
            label: `${r.next_action || r.subject} — ${r.customer_name}`,
            tone: num(r.days_to_next) <= 2 ? 'warn' : 'info',
            value: `${r.days_to_next}d`,
          }))} />
      </div>

      {/* ROW 3 — leaderboard / activity mix / intervention queue */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <TopList title={`${kamSingular} Leaderboard`} sub="By activity volume" items={leaderboard.slice(0, 6)} nameKey="name" valueKey="count" valueFmt={fmtN}
          onItemClick={(item) => openList(
            item.name,
            'Activities logged by this KAM',
            tableRows.filter(r => (r.user || 'Unknown') === item.name),
          )} />

        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <h3 className="text-[13px] font-bold text-slate-900">Activity Type Mix</h3>
          <p className="mt-0.5 text-[11px] text-slate-400">Share of activities by type</p>
          <div className="mt-2">
            {typeMix.map((t, i) => (
              <StatsRow key={t.name} label={t.name} value={fmtN(t.count)}
                pctVal={pct(t.count, tableRows.length)} color={CHART[i % CHART.length]} />
            ))}
            {!typeMix.length && <p className="py-6 text-center text-[12px] text-slate-400">No activities in view</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <h3 className="text-[13px] font-bold text-slate-900">Account Intervention Queue</h3>
          <p className="mt-0.5 text-[11px] text-slate-400">Accounts flagged for re-engagement</p>
          <div className="mt-2 divide-y divide-dashed divide-slate-100">
            {atRisk.slice(0, 4).map(a => (
              <div
                key={a.name}
                onClick={() =>
                  openList(
                    a.name,
                    'Activities for this account flagged for re-engagement',
                    tableRows.filter(r => (r.customer_name || 'Unknown') === a.name),
                  )
                }
                className="flex cursor-pointer items-center justify-between gap-3 py-2.5 hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-bold text-slate-900">{a.name}</p>
                  <p className="text-[11px] text-slate-400">{fmtN(a.count)} activities · last {a.lastDate || '—'}</p>
                </div>
                <span className={`shrink-0 text-[11px] font-bold ${a.overdue > 0 ? 'text-red-600' : 'text-amber-600'}`}>
                  {a.overdue > 0 ? 'Re-engage' : 'Check in'}
                </span>
              </div>
            ))}
            {!atRisk.length && <p className="py-6 text-center text-[12px] text-slate-400">No accounts need intervention — all engaged accounts are active.</p>}
          </div>
        </div>
      </div>

      <Section idx="02" title="Activity Register" desc={`Complete ${kamSingular} list`} />
      <DataTable data={tableRows} columns={cols as any} title={kamLabelLower} showExport showColumnToggle />

      <ListDrilldownModal
        request={listDrill}
        onClose={() => setListDrill(null)}
      />
    </div>
  )
}
