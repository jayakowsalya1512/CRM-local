/**
 * EMDBGTab.tsx — Financial Risk & Tender Security Control Center
 * Premium enterprise-grade EMD / BG Finance Dashboard
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import {
  Shield, AlertTriangle, Building2, Settings2,
  AlertCircle, CheckCircle2, Clock, Banknote,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, AreaChart, Area,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, fmtN, fmtRsL, splitRs, num, pct,
  ChartTip, Badge, KpiCard, ChartShell, DataTable, FilterBar,
  Section, ModuleHead, TabSkeleton, DaysBadge,
  EMPTY_FILTERS, FilterState, ColDef, AXIS_X, AXIS_Y, CGRID,
} from './_shared'

// ─── useSectionDrag ───────────────────────────────────────────────────────────
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
    } catch { /* ignore */ }
    return defaultOrder
  })
  const dragSrc = useRef<string | null>(null)
  const onDragStart = useCallback((id: string) => { dragSrc.current = id }, [])
  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault() }, [])
  const onDrop      = useCallback((targetId: string) => {
    const src = dragSrc.current
    if (!src || src === targetId) return
    setOrder(prev => {
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

// ─── DragSection ──────────────────────────────────────────────────────────────
function DragSection({
  id, arranging, onDragStart, onDragOver, onDrop, children,
}: {
  id: string; arranging: boolean
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

// ─── Local card wrapper ───────────────────────────────────────────────────────
function SCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)] ${className}`}>
      {children}
    </div>
  )
}
function SCardHead({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-slate-200/60 px-5 py-3.5">
      <div>
        <div className="text-[13px] font-semibold tracking-tight text-slate-900">{title}</div>
        {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
      </div>
      {action}
    </div>
  )
}

// ─── Color constants ──────────────────────────────────────────────────────────
const TYPE_COLORS = ['#4338ca','#dc2626','#d97706','#0284c7','#7c3aed','#059669','#db2777']

// ─── Critical Alert Panel ─────────────────────────────────────────────────────
function CriticalAlertPanel({ items }: { items: any[] }) {
  if (!items.length) return (
    <SCard>
      <div className="flex items-center justify-center gap-2.5 py-6 text-sm text-emerald-700">
        <CheckCircle2 size={16} className="flex-shrink-0" />
        <span className="font-semibold">No critical expirations — all instruments secure</span>
      </div>
    </SCard>
  )
  return (
    <SCard>
      <div className="flex items-center gap-2.5 border-b border-red-200/60 bg-gradient-to-r from-red-50 to-white px-5 py-3.5">
        <AlertCircle size={14} className="text-red-600 flex-shrink-0 animate-pulse" />
        <span className="text-[13px] font-bold text-red-900 uppercase tracking-wide">Critical Alert — Expiring ≤7 Days</span>
        <Badge text={String(items.length)} tone="neg" dot={false} />
        <span className="ml-auto text-[11px] font-semibold text-red-600">Immediate action required</span>
      </div>
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        {items.slice(0, 8).map((e: any, i: number) => (
          <div key={i} className="flex flex-col gap-1.5 rounded-xl border border-red-200 bg-gradient-to-b from-red-50/60 to-white p-3.5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] font-bold text-slate-500 truncate">{e.type || 'EMD'}</span>
              <DaysBadge days={e.days_left} />
            </div>
            <div className="text-[12px] font-bold text-slate-900 truncate">{e.client || '—'}</div>
            <div className="text-[10px] text-slate-500 truncate">{e.bank || '—'}</div>
            <div className="mt-0.5 flex items-center justify-between">
              <span className="text-[13px] font-bold text-red-700 tabular-nums">{fmtRsL(num(e.amount))}</span>
              <span className="font-mono text-[10px] text-slate-400">{e.expiry_date || '—'}</span>
            </div>
          </div>
        ))}
      </div>
    </SCard>
  )
}

// ─── Expiry Risk Buckets (color-coded bars) ───────────────────────────────────
const BUCKET_COLORS: Record<string, string> = {
  'Expired': '#0b1220',
  '≤7 days': '#dc2626',
  '8–15 days': '#f97316',
  '16–30 days': '#d97706',
  '31–60 days': '#0284c7',
  '>60 days': '#059669',
}

// ─── Bank Exposure Table ──────────────────────────────────────────────────────
function BankExposureTable({ rows }: { rows: any[] }) {
  const banks = useMemo(() => {
    const m: Record<string, { count: number; active: number; expiring7: number; expired: number; unpaid: number; value: number }> = {}
    rows.forEach(r => {
      const b = r.bank || 'Unknown'
      if (!m[b]) m[b] = { count: 0, active: 0, expiring7: 0, expired: 0, unpaid: 0, value: 0 }
      m[b].count++
      m[b].value += num(r.amount)
      const st = (r.status || '').toLowerCase()
      if (st === 'active') m[b].active++
      if (st === 'expired') m[b].expired++
      const dl = num(r.days_left)
      if (r.days_left != null && dl >= 0 && dl <= 7) m[b].expiring7++
      if ((r.finance_status || '').toLowerCase() === 'unpaid') m[b].unpaid++
    })
    return Object.entries(m).sort((a, b) => b[1].value - a[1].value)
  }, [rows])

  if (!banks.length) return null
  const maxVal = Math.max(...banks.map(([, v]) => v.value), 1)

  return (
    <SCard>
      <SCardHead title="Bank-wise Exposure" sub="Total instrument exposure per bank · active count · risk indicators" />
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">Bank</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Total</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-emerald-700">Active</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-red-700">Critical ≤7d</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-slate-600">Expired</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-amber-700">Unpaid</th>
              <th className="border-b border-slate-200 px-5 py-2.5 text-right">Exposure ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-left w-36">Share</th>
            </tr>
          </thead>
          <tbody>
            {banks.map(([bank, v]) => (
              <tr key={bank} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50">
                      <Building2 size={11} className="text-indigo-600" />
                    </div>
                    <span className="font-semibold text-slate-900">{bank}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{fmtN(v.count)}</td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-emerald-700">{fmtN(v.active)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {v.expiring7 > 0
                    ? <span className="inline-flex items-center gap-1 font-bold text-red-700"><AlertTriangle size={10} />{fmtN(v.expiring7)}</span>
                    : <span className="text-slate-300">0</span>}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-500">{fmtN(v.expired)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {v.unpaid > 0
                    ? <span className="font-bold text-amber-700">{fmtN(v.unpaid)}</span>
                    : <span className="text-slate-300">0</span>}
                </td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-slate-900">{fmtRsL(v.value)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-indigo-500 transition-all duration-700"
                        style={{ width: `${pct(v.value, maxVal)}%` }} />
                    </div>
                    <span className="w-8 text-right font-mono text-[10px] text-slate-500">{pct(v.value, maxVal)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SCard>
  )
}

// ─── Customer Exposure Top List ───────────────────────────────────────────────
function CustomerExposureList({ rows }: { rows: any[] }) {
  const { singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const customers = useMemo(() => {
    const m: Record<string, { count: number; value: number; critical: number }> = {}
    rows.forEach(r => {
      const c = r.client || 'Unknown'
      if (!m[c]) m[c] = { count: 0, value: 0, critical: 0 }
      m[c].count++
      m[c].value += num(r.amount)
      const dl = num(r.days_left)
      if (r.days_left != null && dl >= 0 && dl <= 7) m[c].critical++
    })
    return Object.entries(m)
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
  }, [rows])

  if (!customers.length) return null
  const maxVal = Math.max(...customers.map(c => c.value), 1)

  return (
    <SCard>
      <SCardHead title={`Top 10 — ${customerSingular} Exposure`} sub={`Highest instrument value by ${customerLabelLower}`} />
      <div className="divide-y divide-dashed divide-slate-100 px-5 pb-3 pt-1">
        {customers.map((c, i) => (
          <div key={c.name} className="grid grid-cols-[28px_1fr_auto] items-center gap-3 py-2.5">
            <span className="font-mono text-[11px] font-semibold text-slate-400">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-slate-900 truncate max-w-[200px]">{c.name}</span>
                {c.critical > 0 && (
                  <span className="inline-flex items-center gap-0.5 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700">
                    <AlertTriangle size={8} />{c.critical} critical
                  </span>
                )}
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-indigo-500 transition-all duration-700"
                  style={{ width: `${pct(c.value, maxVal)}%` }} />
              </div>
            </div>
            <div className="text-right">
              <div className="text-[12px] font-bold tabular-nums text-slate-900">{fmtRsL(c.value)}</div>
              <div className="text-[10px] text-slate-400">{fmtN(c.count)} instruments</div>
            </div>
          </div>
        ))}
      </div>
    </SCard>
  )
}

// ─── Status Analysis Table (by instrument status) ────────────────────────────
type StatusDim = 'status' | 'return_status'
function StatusAnalysisTable({ rows }: { rows: any[] }) {
  const [dim, setDim] = useState<StatusDim>('status')

  const data = useMemo(() => {
    const m: Record<string, { count: number; value: number; critical: number }> = {}
    rows.forEach(r => {
      const key = dim === 'status'
        ? (r.status || 'Unknown')
        : (r.return_status || 'Pending')
      if (!m[key]) m[key] = { count: 0, value: 0, critical: 0 }
      m[key].count++
      m[key].value += num(r.amount)
      const dl = num(r.days_left)
      if (r.days_left != null && dl >= 0 && dl <= 15) m[key].critical++
    })
    return Object.entries(m).sort((a, b) => b[1].value - a[1].value)
  }, [rows, dim])

  const maxVal = Math.max(...data.map(([, v]) => v.value), 1)
  const totalVal = data.reduce((s, [, v]) => s + v.value, 0)

  return (
    <SCard>
      <SCardHead
        title={dim === 'status' ? 'Instrument Status Breakdown' : 'Return Status Breakdown'}
        sub="Count and exposure by status"
        action={
          <div className="flex rounded-lg border border-slate-200 p-0.5 text-[11px] font-semibold">
            {(['status', 'return_status'] as StatusDim[]).map(d => (
              <button key={d}
                onClick={() => setDim(d)}
                className={`rounded-md px-3 py-1 transition-colors ${dim === d ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-900'}`}>
                {d === 'status' ? 'Instrument' : 'Return'}
              </button>
            ))}
          </div>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">Status</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Count</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right text-red-700">At Risk ≤15d</th>
              <th className="border-b border-slate-200 px-5 py-2.5 text-right">Exposure ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-right">Share %</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-left w-32">Bar</th>
            </tr>
          </thead>
          <tbody>
            {data.map(([key, v]) => (
              <tr key={key} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors">
                <td className="px-4 py-2.5">
                  <Badge text={key} />
                </td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{fmtN(v.count)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {v.critical > 0
                    ? <span className="font-bold text-red-700">{fmtN(v.critical)}</span>
                    : <span className="text-slate-300">—</span>}
                </td>
                <td className="px-5 py-2.5 text-right font-mono font-bold tabular-nums text-slate-900">{fmtRsL(v.value)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-[11px] text-slate-500 tabular-nums">{pct(v.value, totalVal)}%</td>
                <td className="px-4 py-2.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-indigo-500 transition-all duration-700"
                      style={{ width: `${pct(v.value, maxVal)}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SCard>
  )
}

// ─── Finance Status Breakdown ─────────────────────────────────────────────────
function FinanceSLAPanel({ rows }: { rows: any[] }) {
  const { byFinance, byInstStatus } = useMemo(() => {
    const byFinance: Record<string, { count: number; value: number }> = {}
    const byInstStatus: Record<string, { count: number; value: number }> = {}
    rows.forEach(r => {
      const fs = r.finance_status || 'Unknown'
      if (!byFinance[fs]) byFinance[fs] = { count: 0, value: 0 }
      byFinance[fs].count++
      byFinance[fs].value += num(r.amount)

      const st = r.status || 'Unknown'
      if (!byInstStatus[st]) byInstStatus[st] = { count: 0, value: 0 }
      byInstStatus[st].count++
      byInstStatus[st].value += num(r.amount)
    })
    return { byFinance, byInstStatus }
  }, [rows])

  const financeEntries = Object.entries(byFinance).sort((a, b) => b[1].value - a[1].value)
  const statusEntries  = Object.entries(byInstStatus).sort((a, b) => b[1].value - a[1].value)
  const totalF = financeEntries.reduce((s, [, v]) => s + v.value, 0)
  const totalS = statusEntries.reduce((s, [, v]) => s + v.value, 0)

  const financeColor = (s: string) =>
    s.toLowerCase() === 'paid' ? '#059669' : s.toLowerCase() === 'overdue' ? '#dc2626' : '#d97706'
  const statusColor = (s: string) =>
    s.toLowerCase() === 'active' ? '#059669' : s.toLowerCase() === 'expired' ? '#dc2626'
    : s.toLowerCase() === 'released' ? '#0284c7' : s.toLowerCase() === 'encashed' ? '#7c3aed' : '#94a3b8'

  return (
    <div className="grid grid-cols-2 gap-4">
      <SCard>
        <SCardHead title="Finance Status" sub="Payment status distribution by exposure value" />
        <div className="space-y-2.5 px-5 pb-4 pt-2">
          {financeEntries.map(([status, v]) => {
            const share = pct(v.value, totalF)
            return (
              <div key={status}>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-slate-700">{status}</span>
                  <div className="flex items-center gap-2.5 tabular-nums">
                    <span className="text-slate-500">{fmtN(v.count)}</span>
                    <span className="font-bold text-slate-900">{fmtRsL(v.value)}</span>
                    <span className="font-mono text-[10px] text-slate-400">{share}%</span>
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${share}%`, background: financeColor(status) }} />
                </div>
              </div>
            )
          })}
        </div>
      </SCard>

      <SCard>
        <SCardHead title="Instrument Status" sub="Active · Released · Expired · Encashed" />
        <div className="space-y-2.5 px-5 pb-4 pt-2">
          {statusEntries.map(([status, v]) => {
            const share = pct(v.value, totalS)
            return (
              <div key={status}>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full flex-shrink-0" style={{ background: statusColor(status) }} />
                    <span className="font-semibold text-slate-700">{status}</span>
                  </div>
                  <div className="flex items-center gap-2.5 tabular-nums">
                    <span className="text-slate-500">{fmtN(v.count)}</span>
                    <span className="font-bold text-slate-900">{fmtRsL(v.value)}</span>
                    <span className="font-mono text-[10px] text-slate-400">{share}%</span>
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${share}%`, background: statusColor(status) }} />
                </div>
              </div>
            )
          })}
        </div>
      </SCard>
    </div>
  )
}

// ─── Instrument Type Comparison ───────────────────────────────────────────────
function InstrumentTypeAnalysis({ rows }: { rows: any[] }) {
  const types = useMemo(() => {
    const m: Record<string, { count: number; value: number; active: number; expiring: number }> = {}
    rows.forEach(r => {
      const t = r.type || 'Unknown'
      if (!m[t]) m[t] = { count: 0, value: 0, active: 0, expiring: 0 }
      m[t].count++
      m[t].value += num(r.amount)
      if ((r.status || '').toLowerCase() === 'active') m[t].active++
      const dl = num(r.days_left)
      if (r.days_left != null && dl >= 0 && dl <= 30) m[t].expiring++
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value)
  }, [rows])

  const donutData = types.map((t, i) => ({ name: t.name, value: t.count, fill: TYPE_COLORS[i % TYPE_COLORS.length] }))
  const maxVal = Math.max(...types.map(t => t.value), 1)

  return (
    <div className="grid grid-cols-2 gap-4">
      <ChartShell title="By Instrument Type" sub="Count distribution · EMD · BG · DD · others" height={260}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={donutData} dataKey="value" nameKey="name" cx="50%" cy="46%"
              innerRadius="38%" outerRadius="60%" paddingAngle={2} strokeWidth={0}>
              {donutData.map((d, i) => <Cell key={i} fill={d.fill} />)}
            </Pie>
            <Tooltip content={<ChartTip />} />
            <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 10 }}
              formatter={(v) => <span style={{ color: C.ink3 }}>{v}</span>} />
          </PieChart>
        </ResponsiveContainer>
      </ChartShell>

      <SCard>
        <SCardHead title="Type-wise Exposure" sub="Instrument count · value · active vs expiring" />
        <div className="divide-y divide-dashed divide-slate-100 px-5 pb-3 pt-1">
          {types.map((t, i) => (
            <div key={t.name} className="grid grid-cols-[24px_1fr_auto] items-center gap-3 py-2.5">
              <span className="inline-block h-3 w-3 rounded-sm flex-shrink-0" style={{ background: TYPE_COLORS[i % TYPE_COLORS.length] }} />
              <div>
                <div className="text-[12px] font-semibold text-slate-900">{t.name}</div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct(t.value, maxVal)}%`, background: TYPE_COLORS[i % TYPE_COLORS.length] }} />
                </div>
              </div>
              <div className="text-right">
                <div className="text-[12px] font-bold tabular-nums text-slate-900">{fmtRsL(t.value)}</div>
                <div className="text-[10px] text-slate-400">{fmtN(t.count)} · {fmtN(t.active)} active</div>
              </div>
            </div>
          ))}
        </div>
      </SCard>
    </div>
  )
}

// ─── Section defaults ─────────────────────────────────────────────────────────
const EMDBG_SECTION_DEFAULTS = [
  's_kpi', 's_critical', 's_charts', 's_type', 's_bank', 's_customer', 's_region', 's_finance', 's_table',
]

// ─── Main EMDBGTab ────────────────────────────────────────────────────────────
export default function EMDBGTab() {
  const { label } = useModuleName('emdbg')
  const { singular: customerSingular, labelLower: customerLabelLower } = useModuleName('customers')
  const { singular: tenderSingular } = useModuleName('tenders')
  const [data,           setData]           = useState<any>(null)
  const [loading,        setLoading]        = useState(true)
  const [filters,        setFilters]        = useState<FilterState>(EMPTY_FILTERS)
  const [pendingFilters, setPendingFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [arranging,      setArranging]      = useState(false)

  const { order, onDragStart, onDragOver, onDrop } = useSectionDrag('crm_emdbg_sections_v1', EMDBG_SECTION_DEFAULTS)

  const loadData = useCallback(async (f: FilterState) => {
    setLoading(true)
    try {
      const p = new URLSearchParams()
      Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v) })
      const res = await api.get(`/dashboard/tab/emdbg?${p}`)
      setData(res.data)
    } catch { setData(null) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadData(EMPTY_FILTERS) }, [loadData])

  const handleChange = (k: keyof FilterState, v: string) => setPendingFilters(p => ({ ...p, [k]: v }))
  const handleApply  = () => { setFilters(pendingFilters); loadData(pendingFilters) }
  const handleReset  = () => { setFilters(EMPTY_FILTERS); setPendingFilters(EMPTY_FILTERS); loadData(EMPTY_FILTERS) }


  const s         = data?.summary   || {}
  const c         = data?.charts    || {}
  const tableRows: any[] = data?.table || []

  // Compute derived data from tableRows
  const critical = useMemo(() => {
    const list = tableRows.filter((r: any) => {
      const dl = num(r.days_left)
      return r.days_left != null && dl >= 0 && dl <= 7
    })
    return list.sort((a: any, b: any) => num(a.days_left) - num(b.days_left))
  }, [tableRows])

  const expiryBuckets = useMemo(() => {
    const buckets: Record<string, number> = {
      'Expired': 0, '≤7 days': 0, '8–15 days': 0, '16–30 days': 0, '31–60 days': 0, '>60 days': 0,
    }
    tableRows.forEach((r: any) => {
      const dl = r.days_left != null ? num(r.days_left) : null
      if (dl === null) return
      if (dl < 0) buckets['Expired']++
      else if (dl <= 7) buckets['≤7 days']++
      else if (dl <= 15) buckets['8–15 days']++
      else if (dl <= 30) buckets['16–30 days']++
      else if (dl <= 60) buckets['31–60 days']++
      else buckets['>60 days']++
    })
    return Object.entries(buckets).map(([name, value]) => ({ name, value }))
  }, [tableRows])

  const bankChartData = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach((r: any) => {
      const b = r.bank || 'Unknown'
      m[b] = (m[b] || 0) + num(r.amount)
    })
    return Object.entries(m)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
  }, [tableRows])

  const monthlyTrend = useMemo(() => {
    if (c.monthly_trend?.length) return c.monthly_trend
    const m: Record<string, { issued: number; released: number; value: number }> = {}
    tableRows.forEach((r: any) => {
      const dt = r.issued_date || ''
      const key = dt.slice(0, 7) // YYYY-MM
      if (!key) return
      if (!m[key]) m[key] = { issued: 0, released: 0, value: 0 }
      m[key].issued++
      m[key].value += num(r.amount)
      if ((r.status || '').toLowerCase() === 'released') m[key].released++
    })
    return Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([name, v]) => ({ name, ...v }))
  }, [c.monthly_trend, tableRows])
  if (loading && !data) return <TabSkeleton />

  const valSplit = splitRs(num(s.total_value))
  const activeCount = num(s.active) || tableRows.filter((r: any) => (r.status || '').toLowerCase() === 'active').length
  const expiring7   = num(s.expiring_7) || critical.length
  const expiring30  = num(s.expiring_30) || tableRows.filter((r: any) => { const dl = num(r.days_left); return r.days_left != null && dl >= 0 && dl <= 30 }).length
  const unpaid      = num(s.finance_unpaid) || tableRows.filter((r: any) => (r.finance_status || '').toLowerCase() === 'unpaid').length
  const totalInst   = tableRows.length || num(s.total)

  const cols: ColDef[] = [
    { key: 'ref',           label: 'Ref No',     render: v => <span className="font-mono text-[10px] text-slate-400">{v || '—'}</span> },
    { key: 'client',        label: customerSingular, render: v => <span className="font-semibold text-slate-900">{v || '—'}</span> },
    { key: 'tender_num',    label: `${tenderSingular} No`, render: v => <span className="font-mono text-[10px] text-slate-500">{v || '—'}</span> },
    { key: 'type',          label: 'Type',       render: v => v ? <Badge text={v} tone="info" dot={false} /> : null },
    { key: 'amount',        label: 'Amount ₹',   money: true, align: 'right' },
    { key: 'bank',          label: 'Bank',       render: v => v ? <span className="text-slate-700">{v}</span> : <span className="text-slate-300">—</span> },
    { key: 'issued_date',   label: 'Issued',     render: v => <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span> },
    { key: 'expiry_date',   label: 'Expiry',     render: (v, row) => {
        if (!v) return <span className="text-slate-400">—</span>
        const dl = num(row.days_left)
        const crit = row.days_left != null && dl <= 7
        const warn = row.days_left != null && dl > 7 && dl <= 30
        return <span className={`font-mono text-[11px] font-semibold ${crit ? 'text-red-700' : warn ? 'text-amber-700' : 'text-slate-600'}`}>{v}</span>
    }},
    { key: 'days_left',     label: 'Days Left',  render: v => <DaysBadge days={v} />, align: 'center' },
    { key: 'status',        label: 'Status',     render: v => v ? <Badge text={v} /> : null },
    { key: 'finance_status',label: 'Finance',    render: v => v
        ? <Badge text={v} tone={v.toLowerCase() === 'paid' ? 'pos' : v.toLowerCase() === 'overdue' ? 'neg' : 'warn'} />
        : null },
    { key: 'return_status', label: 'Return',     render: v => v ? <Badge text={v} tone="neutral" dot={false} /> : <span className="text-slate-300">—</span> },
  ]

  const sectionMap: Record<string, React.ReactNode> = {


    s_critical: (
      <>
        <Section idx="02" title="Critical Expiry Alert" desc="Instruments expiring within 7 days" />
        <CriticalAlertPanel items={critical} />
      </>
    ),

    s_charts: (
      <>
        <Section idx="03" title="Distribution & Expiry Risk" desc="Timeline buckets · bank exposure · monthly trend" />
        <div className="grid grid-cols-3 gap-4">
          {/* Expiry risk buckets */}
          <ChartShell title="Expiry Risk Timeline" sub="Instruments by days-to-expiry bucket" height={260}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={expiryBuckets} barSize={30} margin={{ top: 16, right: 8, bottom: 20, left: -10 }}>
                <CartesianGrid {...CGRID} />
                <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 8 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} angle={-30} textAnchor="end" />
                <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
                <Tooltip content={<ChartTip />} />
                <Bar dataKey="value" name="Count" radius={[4, 4, 0, 0]}>
                  {expiryBuckets.map((b, i) => (
                    <Cell key={i} fill={BUCKET_COLORS[b.name] || C.info} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartShell>

          {/* Bank horizontal bar */}
          <ChartShell title="Bank-wise Exposure ₹" sub="Top 8 banks by total instrument value" height={260}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bankChartData} layout="vertical" barSize={14}
                margin={{ top: 4, right: 16, bottom: 4, left: 80 }}>
                <CartesianGrid {...CGRID} horizontal={false} vertical />
                <XAxis type="number" tick={AXIS_Y} axisLine={{ stroke: '#d4dae3' }} tickLine={false}
                  tickFormatter={v => v >= 1e7 ? `${(v/1e7).toFixed(0)}Cr` : v >= 1e5 ? `${(v/1e5).toFixed(0)}L` : `${v}`} />
                <YAxis type="category" dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={false} tickLine={false} width={76} />
                <Tooltip content={<ChartTip money />} />
                <Bar dataKey="value" name="Exposure" fill={C.primary} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartShell>

          {/* Monthly trend */}
          <ChartShell title="Monthly Trend" sub="Instruments issued vs released over time" height={260}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthlyTrend} margin={{ top: 16, right: 8, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="issuedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={C.primary} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={C.primary} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="releasedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={C.pos} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={C.pos} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...CGRID} />
                <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
                <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
                <Tooltip content={<ChartTip />} />
                <Area dataKey="issued"   name="Issued"   stroke={C.primary} strokeWidth={2} fill="url(#issuedGrad)"   dot={false} />
                <Area dataKey="released" name="Released" stroke={C.pos}     strokeWidth={2} fill="url(#releasedGrad)" dot={false} />
                <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 10 }}
                  formatter={(v) => <span style={{ color: C.ink3 }}>{v}</span>} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartShell>
        </div>
      </>
    ),

    s_type: (
      <>
        <Section idx="04" title="Instrument Type Analysis" desc="EMD · BG · DD — count, exposure, activity" />
        <InstrumentTypeAnalysis rows={tableRows} />
      </>
    ),

    // s_bank: (
    //   <>
    //     <Section idx="05" title="Bank Exposure Detail" desc="Full bank-wise breakdown with risk indicators" />
    //     <BankExposureTable rows={tableRows} />
    //   </>
    // ),

    s_customer: (
      <>
        <Section idx="06" title={`${customerSingular} Exposure`} desc={`Top ${customerLabelLower} by total instrument value`} />
        <CustomerExposureList rows={tableRows} />
      </>
    ),

    s_region: (
      <>
        <Section idx="07" title="Status Analysis" desc="Instrument status · return status breakdown" />
        <StatusAnalysisTable rows={tableRows} />
      </>
    ),

    s_finance: (
      <>
        <Section idx="08" title="Finance & Risk Intelligence" desc="Payment status · risk level classification" />
        <FinanceSLAPanel rows={tableRows} />
      </>
    ),

    s_table: (
      <>
        <Section idx="09" title="All Instruments" desc="Complete instrument registry" />
        <DataTable rows={tableRows} columns={cols} title="emd-bg-instruments" />
      </>
    ),
  }

  return (
    <div className="space-y-5 p-6">
      <ModuleHead
        icon={<Shield size={20} />}
        title={`${label} Finance Control Center`}
        subtitle="Financial risk management · instrument tracking · bank exposure · expiry intelligence"
        stats={[
          { label: 'Active',    value: fmtN(activeCount) },
          { label: 'Exposure',  value: fmtRsL(num(s.total_value) || tableRows.reduce((s: number, r: any) => s + num(r.instrument_amount || r.amount), 0)), tone: 'info' },
          { label: 'Critical',  value: fmtN(expiring7),  tone: expiring7 > 0 ? 'neg' : undefined },
          { label: 'Unpaid',    value: fmtN(unpaid),     tone: unpaid > 0 ? 'warn' : undefined },
        ]}
        onRefresh={() => { loadData(filters) }}
        loading={loading}
        extra={
          <button
            onClick={() => setArranging(a => !a)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              arranging ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-700 shadow-sm hover:border-slate-400'
            }`}
          >
            <Settings2 size={13} />
            {arranging ? 'Done' : 'Arrange'}
          </button>
        }
      />

      <FilterBar
        filters={pendingFilters}
        onChange={handleChange}
        onApply={handleApply}
        onReset={handleReset}
        filterOptions={data?.filters || {}}
        loading={loading}
      />

      {order.map(id => (
        <DragSection
          key={id}
          id={id}
          arranging={arranging}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <div className="space-y-3">
            {sectionMap[id]}
          </div>
        </DragSection>
      ))}
    </div>
  )
}
