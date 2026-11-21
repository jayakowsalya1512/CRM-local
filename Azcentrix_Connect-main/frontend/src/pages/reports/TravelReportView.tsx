/**
 * TravelReportView.tsx — Travel Analytics report (Reports section).
 * Data source: GET /reports/travel + /reports/travel/filter-options (reports_router.py).
 * Enterprise analytics layout: command-center KPI card + route-insight story card,
 * monthly trend + top routes, traveller/status/visit-type breakdowns and the full
 * travel register. All KPIs/charts computed client-side from the in-memory rows
 * so global search filters everything consistently.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AreaChart, Area, CartesianGrid, XAxis, YAxis } from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, CHART, fmtN, fmtRsL, num, pct, ChartTip, Badge, KpiCard, ChartShell,
  Section, TabSkeleton, StatsRow, ColDef, AXIS_X, AXIS_Y, CGRID, Tooltip, ResponsiveContainer, exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import { AnalyticsFilterBar, AnalyticsFilterState, EMPTY_ANALYTICS_FILTERS } from './shared/AnalyticsFilterBar'
import { ListDrilldownModal, ListDrilldownRequest } from './shared/ListDrilldownModal'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

// Server-side filters supported by GET /reports/travel; search stays client-side.
function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()
  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.owner) p.set('assigned_to', f.owner)
  if (f.status) p.set('status', f.status)
  if (f.customer_id) p.set('customer_id', f.customer_id)
  p.set('per_page', '1000')
  return p
}
const SERVER_KEYS: (keyof AnalyticsFilterState)[] = ['date_from', 'date_to', 'owner', 'status', 'customer_id']

export default function TravelReportView() {
  const { label: travelLabel, labelLower: travelLabelLower } = useModuleName('travel')
  const { singular: customerSingular } = useModuleName('customers')
  const [rows, setRows] = useState<any[]>([])
  const [options, setOptions] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const initialGlobalRange = useInitialGlobalDateRange()
  const [filters, setFilters] = useState<AnalyticsFilterState>(() => ({ ...EMPTY_ANALYTICS_FILTERS, ...initialGlobalRange }))
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const loadData = useCallback(async (f: AnalyticsFilterState) => {
    setLoading(true)
    try {
      const res = await api.get(`/reports/travel?${toBackendParams(f)}`)
      setRows(res.data?.data || [])
    } catch { setRows([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    loadData(filters)
    api.get('/reports/travel/filter-options')
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

  // ── Derived metrics (all client-side) ──────────────────────────────────────
  const totalSpend = useMemo(() => tableRows.reduce((s, r) => s + num(r.estimated_total), 0), [tableRows])
  const approvedRows = useMemo(() => tableRows.filter(r => r.status === 'Approved' || r.status === 'Completed'), [tableRows])
  const approvedCount = approvedRows.length
  const approvalRate = pct(approvedCount, tableRows.length)
  const pendingRows = useMemo(() => tableRows.filter(r => r.status === 'Draft' || r.status === 'Submitted'), [tableRows])
  const pendingCount = pendingRows.length
  const rejectedRows = useMemo(() => tableRows.filter(r => r.status === 'Rejected'), [tableRows])
  const rejectedCount = rejectedRows.length
  const advanceExposureRows = useMemo(() =>
    tableRows.filter(r => r.advance_required === 'Yes' && r.status !== 'Completed' && r.status !== 'Cancelled'),
    [tableRows])
  const advanceExposure = useMemo(() =>
    advanceExposureRows.reduce((s, r) => s + num(r.advance_amount), 0),
    [advanceExposureRows])
  const outsideRows = useMemo(() => tableRows.filter(r => r.is_outside_district === 'Yes'), [tableRows])
  const outsideShare = pct(outsideRows.length, tableRows.length)

  const routes = useMemo(() => {
    const m: Record<string, { count: number; spend: number }> = {}
    tableRows.forEach(r => {
      if (!r.from_city || !r.to_city) return
      const key = `${r.from_city} → ${r.to_city}`
      if (!m[key]) m[key] = { count: 0, spend: 0 }
      m[key].count++; m[key].spend += num(r.estimated_total)
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count)
  }, [tableRows])
  const topRoute = routes[0]

  const monthlyTrend = useMemo(() => {
    const m: Record<string, { count: number; spend: number }> = {}
    tableRows.forEach(r => {
      const key = (r.travel_date || '').slice(0, 7)
      if (!key) return
      if (!m[key]) m[key] = { count: 0, spend: 0 }
      m[key].count++; m[key].spend += num(r.estimated_total)
    })
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, v]) => ({ month, ...v }))
  }, [tableRows])

  const topTravellers = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const name = r.employee || 'Unknown'
      m[name] = (m[name] || 0) + num(r.estimated_total)
    })
    return Object.entries(m).map(([name, spend]) => ({ name, spend })).sort((a, b) => b.spend - a.spend)
  }, [tableRows])

  const statusMix = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const s = r.status || 'Unknown'
      m[s] = (m[s] || 0) + 1
    })
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }, [tableRows])

  const visitTypes = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const t = r.visit_type || 'Other'
      m[t] = (m[t] || 0) + 1
    })
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }, [tableRows])

  const maxRouteCount = Math.max(...routes.slice(0, 6).map(r => r.count), 1)

  const statusTone = (s: string) =>
    s === 'Approved' || s === 'Completed' ? C.pos : s === 'Rejected' || s === 'Cancelled' ? C.neg : C.warn

  const cols: ColDef[] = [
    { key: 'request_number', label: 'Request No', render: v => <span className="font-mono text-[10px] text-slate-500">{v || '—'}</span> },
    { key: 'employee', label: 'Employee', render: v => <span className="font-semibold text-slate-900">{v || '—'}</span> },
    { key: 'purpose', label: 'Purpose', render: v => <span className="truncate max-w-[200px] block text-slate-600">{v || '—'}</span> },
    { key: 'visit_type', label: 'Visit Type' },
    { key: 'customer_name', label: customerSingular },
    { key: 'from_city', label: 'From' },
    { key: 'to_city', label: 'To' },
    { key: 'travel_date', label: 'Travel Date', render: v => <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span> },
    { key: 'total_days', label: 'Days', align: 'right' },
    { key: 'transport_mode', label: 'Mode' },
    { key: 'status', label: 'Status', render: v => v ? <Badge text={v} /> : null },
    { key: 'estimated_total', label: 'Est. Total ₹', money: true, align: 'right' },
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
        onExport={() => exportRows(tableRows, cols, 'travel')}
        filterOptions={{
          owners: options?.users, statuses: options?.statuses, customers: options?.customers,
        }}
        loading={loading}
      />

      {/* ROW 1 — command center + route-insight story */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.25fr_.75fr] gap-4">
        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-600">{travelLabel} spend intelligence</p>
          <h3 className="mt-1 text-lg font-black tracking-tight text-slate-900">Cost leakage, approval discipline and route efficiency</h3>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 mt-4">
            <KpiCard label="Total Estimated Spend" value={fmtRsL(totalSpend)} tone="primary" sub={`${fmtN(tableRows.length)} requests in view`}
              onClick={() => openList('Total Estimated Spend', `All ${travelLabelLower} requests in view`, tableRows)} />
            <KpiCard label="Approval Rate" value={`${approvalRate}%`} tone="pos" sub={`${fmtN(approvedCount)} approved`}
              onClick={() => openList('Approved Requests', 'Requests marked Approved or Completed', approvedRows)} />
            <KpiCard label="Pending Approval" value={fmtN(pendingCount)} tone="warn" alert={pendingCount > 0}
              onClick={() => openList('Pending Approval', 'Requests still in Draft or Submitted status', pendingRows)} />
            <KpiCard label="Advance Exposure" value={fmtRsL(advanceExposure)} tone="info" sub="advances outstanding"
              onClick={() => openList('Advance Exposure', 'Outstanding advances excluding Completed/Cancelled requests', advanceExposureRows)} />
          </div>
        </div>

        <div className="rounded-2xl border border-[#e6eaf1] border-l-4 border-l-cyan-500 bg-gradient-to-br from-cyan-50/40 to-white p-5">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-600">Route insight</p>
          <h3 className="mt-1 text-lg font-black tracking-tight text-slate-900">
            {topRoute ? `${topRoute.name} is the most travelled route` : 'No repeated routes in view'}
          </h3>
          <p
            className={topRoute ? 'mt-1 text-[12px] text-slate-600 cursor-pointer hover:underline' : 'mt-1 text-[12px] text-slate-600'}
            onClick={topRoute ? () => openList(
              topRoute.name,
              'Trips on this route',
              tableRows.filter(r => `${r.from_city} → ${r.to_city}` === topRoute.name),
            ) : undefined}
          >
            {fmtN(topRoute?.count ?? 0)} trips · {fmtRsL(topRoute?.spend ?? 0)} estimated spend
          </p>
          <div className="grid grid-cols-3 gap-2 text-center mt-4">
            <div
              className="rounded-xl border border-[#e6eaf1] bg-white p-3 cursor-pointer transition hover:border-slate-300 hover:shadow-sm"
              onClick={() => openList('Rejected Requests', 'Travel requests rejected', rejectedRows)}
            >
              <p className="text-lg font-black text-red-600">{fmtN(rejectedCount)}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">rejected</p>
            </div>
            <div
              className="rounded-xl border border-[#e6eaf1] bg-white p-3 cursor-pointer transition hover:border-slate-300 hover:shadow-sm"
              onClick={() => openList('Pending Approval', 'Requests still in Draft or Submitted status', pendingRows)}
            >
              <p className="text-lg font-black text-amber-600">{fmtN(pendingCount)}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">pending</p>
            </div>
            <div
              className="rounded-xl border border-[#e6eaf1] bg-white p-3 cursor-pointer transition hover:border-slate-300 hover:shadow-sm"
              onClick={() => openList(`Outside District ${travelLabel}`, 'Trips marked outside district', outsideRows)}
            >
              <p className="text-lg font-black text-emerald-600">{outsideShare}%</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">outside district</p>
            </div>
          </div>
        </div>
      </div>

      {/* ROW 2 — monthly trend + top routes */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_.9fr] gap-4">
        <ChartShell title={`Monthly ${travelLabel} Trend`} sub={`Requests and estimated spend by ${travelLabelLower} month`} height={290}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={monthlyTrend}
              margin={{ top: 16, right: 8, bottom: 0, left: -10 }}
              onClick={(e: any) => {
                const month = e?.activeLabel
                if (!month) return
                openList(month, `${travelLabel} requests in this month`, tableRows.filter(r => (r.travel_date || '').slice(0, 7) === month))
              }}
              style={{ cursor: 'pointer' }}
            >
              <defs>
                <linearGradient id="tvCountGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.primary} stopOpacity={0.25} /><stop offset="95%" stopColor={C.primary} stopOpacity={0.02} /></linearGradient>
                <linearGradient id="tvSpendGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.info} stopOpacity={0.2} /><stop offset="95%" stopColor={C.info} stopOpacity={0.02} /></linearGradient>
              </defs>
              <CartesianGrid {...CGRID} />
              <XAxis dataKey="month" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
              <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
              <Tooltip content={<ChartTip />} />
              <Area dataKey="count" name="Requests" stroke={C.primary} strokeWidth={2} fill="url(#tvCountGrad)" dot={false} />
              <Area dataKey="spend" name="Est. Spend" stroke={C.info} strokeWidth={2} fill="url(#tvSpendGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartShell>

        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="text-[13px] font-semibold tracking-tight text-slate-900">Top Routes</div>
          <div className="mt-0.5 text-[11px] text-slate-500">Most travelled city pairs by trip count</div>
          <div className="mt-2">
            {routes.length === 0 && <p className="py-6 text-center text-[12px] text-slate-400">No routes in view</p>}
            {routes.slice(0, 6).map((r, i) => (
              <div
                key={r.name}
                onClick={() => openList(r.name, 'Trips on this route', tableRows.filter(row => `${row.from_city} → ${row.to_city}` === r.name))}
                className="cursor-pointer rounded-lg transition hover:bg-slate-50"
              >
                <StatsRow label={r.name} value={fmtN(r.count)} sub={fmtRsL(r.spend)}
                  pctVal={pct(r.count, maxRouteCount)} color={CHART[i % CHART.length]} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ROW 3 — travellers / status mix / visit types */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="px-5 pt-4 pb-3">
            <div className="text-[13px] font-semibold tracking-tight text-slate-900">Top Travellers by Spend</div>
            <div className="mt-0.5 text-[11px] text-slate-500">By estimated travel cost</div>
          </div>
          <div className="divide-y divide-dashed divide-slate-100 px-[18px] pb-4">
            {topTravellers.slice(0, 6).map((t, i) => {
              const maxSpend = Math.max(...topTravellers.slice(0, 6).map(x => num(x.spend)), 1)
              const barW = ((num(t.spend) / maxSpend) * 100).toFixed(1)
              return (
                <div
                  key={t.name}
                  onClick={() => openList(t.name, `${travelLabel} requests for this traveller`, tableRows.filter(r => (r.employee || 'Unknown') === t.name))}
                  className="grid grid-cols-[28px_1fr_auto] items-center gap-2.5 py-2.5 cursor-pointer transition hover:bg-slate-50"
                >
                  <span className="font-mono text-[11px] font-semibold text-slate-400">{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <div className="text-[13px] font-medium text-slate-900 truncate max-w-[200px]">{t.name || '—'}</div>
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${barW}%`, background: C.primary }} />
                    </div>
                  </div>
                  <span className="text-[13px] font-semibold tabular-nums text-slate-900 whitespace-nowrap">{fmtRsL(t.spend)}</span>
                </div>
              )
            })}
            {topTravellers.length === 0 && <p className="py-6 text-center text-[12px] text-slate-400">No travellers in view</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="text-[13px] font-semibold tracking-tight text-slate-900">Status Mix</div>
          <div className="mt-0.5 text-[11px] text-slate-500">Requests by approval status</div>
          <div className="mt-2">
            {statusMix.map(s => (
              <div
                key={s.name}
                onClick={() => openList(s.name, 'Requests with this status', tableRows.filter(row => (row.status || 'Unknown') === s.name))}
                className="cursor-pointer rounded-lg transition hover:bg-slate-50"
              >
                <StatsRow label={s.name} value={fmtN(s.count)}
                  pctVal={pct(s.count, tableRows.length)} color={statusTone(s.name)} />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="text-[13px] font-semibold tracking-tight text-slate-900">Visit Types</div>
          <div className="mt-0.5 text-[11px] text-slate-500">Purpose of travel</div>
          <div className="mt-2">
            {visitTypes.slice(0, 5).map((t, i) => (
              <div
                key={t.name}
                onClick={() => openList(t.name, 'Travel requests for this visit type', tableRows.filter(row => (row.visit_type || 'Other') === t.name))}
                className="cursor-pointer rounded-lg transition hover:bg-slate-50"
              >
                <StatsRow label={t.name} value={fmtN(t.count)}
                  pctVal={pct(t.count, tableRows.length)} color={CHART[i % CHART.length]} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <Section idx="02" title="Travel Register" desc="Complete travel request list" />
      <DataTable data={tableRows} columns={cols as any} title="travel" showExport showColumnToggle />

      <ListDrilldownModal
        request={listDrill}
        onClose={() => setListDrill(null)}
      />
    </div>
  )
}
