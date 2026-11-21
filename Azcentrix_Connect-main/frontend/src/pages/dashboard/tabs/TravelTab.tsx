/**
 * TravelTab.tsx — Travel Request & TA/DA Analytics
 * • Pending approval alert list
 * • Route/mode analysis charts
 * • Employee comparison table
 * • Advance disbursement tracking
 */
import { useEffect, useState, useCallback, useMemo } from 'react'
import { Navigation, AlertCircle, Users, DollarSign, Settings2  } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, AreaChart, Area,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, CHART, fmtN, fmtRsL, splitRs, num, pct,
  ChartTip, Badge, KpiCard, ChartShell, TopList, DataTable, FilterBar,
  Section, ModuleHead, TabSkeleton, ComparisonPanel,
  EMPTY_FILTERS, FilterState, ColDef, DaysBadge, AXIS_X, AXIS_Y, CGRID,
} from './_shared'

const TRAVEL_COLOR = '#7e22ce'
const TRAVEL_SOFT  = 'rgba(126,34,206,0.12)'

// ─── Employee comparison table ────────────────────────────────────────────────
function EmployeeComparisonTable({ rows }: { rows: any[] }) {
  const { labelLower } = useModuleName('travel')
  const byEmployee = useMemo(() => {
    const m: Record<string, { total: number; approved: number; pending: number; rejected: number; completed: number; advance: number }> = {}
    rows.forEach(r => {
      const e = r.employee || r.employee_name || 'Unknown'
      if (!m[e]) m[e] = { total: 0, approved: 0, pending: 0, rejected: 0, completed: 0, advance: 0 }
      m[e].total++
      const st = (r.status || '').toLowerCase()
      if (st === 'approved')  m[e].approved++
      if (st === 'pending' || st === 'submitted') m[e].pending++
      if (st === 'rejected')  m[e].rejected++
      if (st === 'completed') m[e].completed++
      m[e].advance += num(r.advance_amount)
    })
    return Object.entries(m).sort((a, b) => b[1].total - a[1].total)
  }, [rows])

  if (!byEmployee.length) return null

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="border-b border-slate-200/60 px-5 py-3.5">
        <div className="text-[13px] font-semibold text-slate-900">Employee {labelLower} summary</div>
        <div className="mt-0.5 text-[11px] text-slate-500">Requests · approvals · advance disbursed</div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">Employee</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Total</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Approved</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-amber-700">Pending</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-red-700">Rejected</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-sky-700">Completed</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Advance ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Approval %</th>
            </tr>
          </thead>
          <tbody>
            {byEmployee.map(([name, v]) => {
              const approvalRate = v.total ? Math.round((v.approved / v.total) * 100) : 0
              return (
                <tr key={name} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-2.5 font-medium text-slate-900">{name}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{fmtN(v.total)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-emerald-700">{fmtN(v.approved)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-amber-700">{fmtN(v.pending)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-red-700">{fmtN(v.rejected)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-sky-700">{fmtN(v.completed)}</td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">{fmtRsL(v.advance)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold tabular-nums ${approvalRate >= 70 ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : approvalRate >= 40 ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                      {approvalRate}%
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

// ─── Pending requests panel ───────────────────────────────────────────────────
function PendingPanel({ rows }: { rows: any[] }) {
  const pending = useMemo(() =>
    rows.filter(r => ['Pending', 'Submitted'].includes(r.status || '')).slice(0, 8),
    [rows])

  if (!pending.length) return null
  return (
    <div className="overflow-hidden rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white shadow-[0_4px_16px_rgba(15,23,42,0.05)]">
      <div className="flex items-center gap-2.5 border-b border-amber-200/60 px-5 py-3.5">
        <AlertCircle size={14} className="text-amber-600" />
        <span className="text-[13px] font-semibold text-amber-900">Pending approval</span>
        <Badge text={String(pending.length)} tone="warn" dot={false} />
      </div>
      <div className="divide-y divide-amber-100">
        {pending.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-5 py-3">
            <div>
              <div className="text-[13px] font-medium text-slate-900">
                {r.employee || r.employee_name} — {r.from_city} → {r.to_city}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {r.travel_date} · {r.visit_type || r.mode || '—'} · {r.purpose && r.purpose.slice(0, 40)}
              </div>
            </div>
            <Badge text={r.mode || r.mode_of_travel || 'Road'} tone="neutral" dot={false} />
            <span className="font-mono text-[11px] text-slate-700 tabular-nums">{fmtRsL(num(r.advance_amount))}</span>
            <Badge text="Pending" tone="warn" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main TravelTab ───────────────────────────────────────────────────────────
export default function TravelTab() {
  const { label, singular, labelLower, singularLower } = useModuleName('travel')
  const [data,          setData]          = useState<any>(null)
  const [loading,       setLoading]       = useState(true)
  const [filters,       setFilters]       = useState<FilterState>(EMPTY_FILTERS)
  const [pendingFilters,setPendingFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [arranging, setArranging] = useState(false)

  const loadData = useCallback(async (f: FilterState) => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v) })
      const res = await api.get(`/dashboard/tab/travel?${p}`)
      setData(res.data)
    } catch { setData(null) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadData(EMPTY_FILTERS) }, [loadData])

  const handleChange = (k: keyof FilterState, v: string) => setPendingFilters(p => ({ ...p, [k]: v }))
  const handleApply  = () => { setFilters(pendingFilters); loadData(pendingFilters) }
  const handleReset  = () => { setFilters(EMPTY_FILTERS); setPendingFilters(EMPTY_FILTERS); loadData(EMPTY_FILTERS) }

  if (loading && !data) return <TabSkeleton />

  const s  = data?.summary || {}
  const c  = data?.charts  || {}
  const tableRows: any[] = data?.table || []

  const advSplit = splitRs(num(s.advance_total))

  const cols: ColDef[] = [
    { key: 'request_number', label: 'Req #',    render: v => <span className="font-mono text-[10px] text-slate-400">{v}</span> },
    { key: 'employee',       label: 'Employee', render: v => <span className="font-semibold text-slate-900">{v}</span> },
    { key: 'purpose',        label: 'Purpose',  render: v => <span className="line-clamp-1 block max-w-[180px]">{v}</span> },
    { key: 'visit_type',     label: 'Type',     render: v => v ? <Badge text={v} tone="neutral" dot={false} /> : null },
    { key: 'from_city',      label: 'From' },
    { key: 'to_city',        label: 'To' },
    { key: 'travel_date',    label },
    { key: 'return_date',    label: 'Return' },
    { key: 'mode',           label: 'Mode' },
    { key: 'status',         label: 'Status',   render: v => v ? <Badge text={v} /> : null },
    { key: 'advance_required', label: 'Adv?',   align: 'center',
      render: v => <span className={`font-mono text-[10px] font-bold ${v ? 'text-emerald-700' : 'text-slate-400'}`}>{v ? 'YES' : 'NO'}</span> },
    { key: 'advance_amount', label: 'Advance ₹',money: true, align: 'right' },
  ]

  return (
    <div className="space-y-5 p-6">

      <ModuleHead
        icon={<Navigation size={20} />}
        title={`${label} & TA/DA`}
        subtitle={`${label} requests · approvals · advance tracking`}
        stats={[
          { label: 'Total',    value: fmtN(num(s.total)) },
          { label: 'Approved', value: fmtN(num(s.approved)),  tone: 'pos' },
          { label: 'Pending',  value: fmtN(num(s.pending)),   tone: 'warn' },
          { label: 'Advance',  value: fmtRsL(num(s.advance_total)), tone: 'info' },
        ]}
        onRefresh={() => loadData(filters)}
        loading={loading}
        // extra={
        //   <button
        //     onClick={() => setArranging(a => !a)}
        //     className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        //       arranging ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-400'
        //     }`}
        //   >
        //     <Settings2 size={13} />
        //     {arranging ? 'Done' : 'Arrange'}
        //   </button>
        // }
      />

      <FilterBar filters={pendingFilters} onChange={handleChange} onApply={handleApply} onReset={handleReset} filterOptions={data?.filters || {}} loading={loading} />

      {/* ── KPIs ────────────────────────────────────────────────────────── */}
      <Section idx="01" title="Request flow" />
      <div className="grid grid-cols-3 gap-3.5 sm:grid-cols-6">
        <KpiCard label="Total requests" value={fmtN(num(s.total))}     tone="primary"  delta={15}   sub="this month" />
        <KpiCard label="Approved"       value={fmtN(num(s.approved))}  tone="pos"      sub={`${num(s.total) ? Math.round(num(s.approved)/num(s.total)*100) : 0}% approval rate`} />
        <KpiCard label="Pending"        value={fmtN(num(s.pending))}   tone="warn"     alert={num(s.pending)>0} sub="awaiting decision" />
        <KpiCard label="Rejected"       value={fmtN(num(s.rejected))}  tone="neg"      alert={num(s.rejected)>0} sub="this period" />
        <KpiCard label="Completed"      value={fmtN(num(s.completed))} tone="info"     sub="trips done" />
        <KpiCard label="Advance total"  value={advSplit.val}            unit={advSplit.unit ? `₹${advSplit.unit}` : '₹'} spotlight sub="disbursed" />
      </div>

      {/* ── Pending alert ───────────────────────────────────────────────── */}
      {num(s.pending) > 0 && (
        <>
          <Section idx="02" title="Pending approvals" desc={`${num(s.pending)} awaiting action`} />
          <PendingPanel rows={tableRows} />
        </>
      )}

      {/* ── Charts ──────────────────────────────────────────────────────── */}
      <Section idx={num(s.pending) > 0 ? '03' : '02'} title="Distribution & trends" />
      <div className="grid grid-cols-[1fr_1fr_1.4fr] gap-4">
        {/* By status */}
        <ChartShell title="By status" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={c.by_status || []} dataKey="value" nameKey="name" cx="50%" cy="46%"
                innerRadius="42%" outerRadius="62%" paddingAngle={2} strokeWidth={0}>
                {(c.by_status || []).map((_: any, i: number) => <Cell key={i} fill={CHART[i % CHART.length]} />)}
              </Pie>
              <Tooltip content={<ChartTip />} />
              <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 10 }}
                formatter={(v) => <span style={{ color: C.ink3 }}>{v}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </ChartShell>

        {/* By mode */}
        <ChartShell title={`By ${labelLower} mode`} height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={c.by_mode || []} layout="vertical" barSize={14}
              margin={{ top: 0, right: 16, bottom: 0, left: 68 }}>
              <CartesianGrid {...CGRID} horizontal={false} vertical />
              <XAxis type="number" tick={AXIS_Y} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
              <YAxis type="category" dataKey="name" tick={AXIS_X} axisLine={false} tickLine={false} width={64} />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="value" name="Requests" fill={TRAVEL_COLOR} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartShell>

        {/* Monthly trend */}
        <ChartShell title="Monthly requests" sub="Last 6 months" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={c.monthly_trend || []} margin={{ top: 8, right: 12, bottom: 0, left: -10 }}>
              <defs>
                <linearGradient id="trvGr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={TRAVEL_COLOR} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={TRAVEL_COLOR} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...CGRID} />
              <XAxis dataKey="month" tick={AXIS_X} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
              <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
              <Tooltip content={<ChartTip />} />
              <Area type="monotone" dataKey="value" name="Requests" stroke={TRAVEL_COLOR} strokeWidth={2}
                fill="url(#trvGr)"
                dot={{ r: 3, fill: '#fff', stroke: TRAVEL_COLOR, strokeWidth: 2 }} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartShell>
      </div>

      {/* ── Period comparison ────────────────────────────────────────────── */}
      {/* <Section idx="04" title="Period comparison" />
      <ComparisonPanel
        title="Travel metrics · current vs previous period"
        rows={[
          { label: 'Total requests', current: num(s.total),    previous: num(s.prev_total),    fmt: fmtN },
          { label: 'Approved',       current: num(s.approved), previous: num(s.prev_approved), fmt: fmtN },
          { label: 'Advance total',  current: num(s.advance_total), previous: num(s.prev_advance), fmt: fmtRsL },
          { label: 'Rejected',       current: num(s.rejected), previous: num(s.prev_rejected), fmt: fmtN, tone: 'neg' },
        ]}
      /> */}

      {/* ── Employee comparison ──────────────────────────────────────────── */}
      <Section idx="05" title="Employee comparison" desc={`${label} by team member`} />
      <EmployeeComparisonTable rows={tableRows} />

      {/* ── Data table ──────────────────────────────────────────────────── */}
      <Section idx="06" title="All requests" />
      <DataTable rows={tableRows} columns={cols} title={labelLower} />
    </div>
  )
}
