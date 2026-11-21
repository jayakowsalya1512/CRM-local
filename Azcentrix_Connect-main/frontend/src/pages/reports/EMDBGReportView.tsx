/**
 * EMDBGReportView.tsx — EMD/BG Analytics report (Reports section).
 * Data source: GET /reports/emdbg + /reports/emdbg/filter-options (reports_router.py).
 * Financial-risk dense layout: 3 KPIs, a 3-column hero (bank ranking + release status /
 * expiry & trend charts / risk gauge + type mix) and ONE consolidated risk-control table
 * with drilldown. KPIs/charts computed client-side from the in-memory rows so global
 * search filters everything consistently.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Receipt, Coins, Landmark, AlertTriangle, CheckCircle2, ShieldCheck } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell, AreaChart, Area, PieChart, Pie, LabelList } from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, fmtN, fmtRsL, num, pct, ChartTip, Badge, KpiCard, ChartShell, StatsRow,
  Section, TabSkeleton, DaysBadge, ColDef, AXIS_X, AXIS_Y, CGRID,
  Tooltip, ResponsiveContainer, exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import { GaugeCard } from '../dashboard/tabs/_analyticsCharts'
import { InsightGrid, InsightItem } from '../dashboard/tabs/InsightCard'
import { AnalyticsFilterBar, AnalyticsFilterState, EMPTY_ANALYTICS_FILTERS } from './shared/AnalyticsFilterBar'
import { DrilldownRequest } from './shared/DrilldownDrawer'
import { RecordViewPanel } from '../report-engine/RecordViewPanel'
import { ListDrilldownModal, ListDrilldownRequest } from './shared/ListDrilldownModal'
import { DistributionSection } from './shared/DistributionCharts'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

const BUCKET_COLORS: Record<string, string> = {
  'Expired': '#0b1220', '≤7 days': '#dc2626', '8–15 days': '#f97316',
  '16–30 days': '#d97706', '31–60 days': '#0284c7', '>60 days': '#059669',
}

// Instrument category split — same grouping as the EMD/BG module's own analytics tab
// (EMDBGPage.tsx), so the two views read consistently.
type InstrumentCategory = 'Tender Fee' | 'EMD' | 'PBG'
const TENDER_FEE_TYPES = ['DD', 'Online Payment']
const EMD_TYPES = ['EMD']
function getInstrumentCategory(type: string): InstrumentCategory {
  if (TENDER_FEE_TYPES.includes(type)) return 'Tender Fee'
  if (EMD_TYPES.includes(type)) return 'EMD'
  return 'PBG'
}
const CATEGORY_CONFIG: Record<InstrumentCategory, {
  label: string
  Icon: typeof Receipt
  accent: string
  track: string
  soft: string
  border: string
  text: string
}> = {
  'Tender Fee': {
    label: 'Tender Fee', Icon: Receipt,
    accent: '#f97316', track: '#ffedd5', soft: '#fff7ed', border: '#fed7aa', text: '#c2410c',
  },
  'EMD': {
    label: 'EMD', Icon: Coins,
    accent: '#2563eb', track: '#dbeafe', soft: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8',
  },
  'PBG': {
    label: 'Bank Guarantees', Icon: Landmark,
    accent: '#7c3aed', track: '#ede9fe', soft: '#f5f3ff', border: '#ddd6fe', text: '#6d28d9',
  },
}

// Server-side filters supported by GET /reports/emdbg. The endpoint has no date_from/date_to —
// the filter bar's date range maps to issued_from/issued_to; owner maps to created_by.
function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()
  if (f.date_from) p.set('issued_from', f.date_from)
  if (f.date_to) p.set('issued_to', f.date_to)
  if (f.owner) p.set('created_by', f.owner)
  if (f.status) p.set('status', f.status)
  if (f.customer_id) p.set('customer_id', f.customer_id)
  p.set('per_page', '1000')
  return p
}
const SERVER_KEYS: (keyof AnalyticsFilterState)[] = ['date_from', 'date_to', 'owner', 'status', 'customer_id']

// Click-enabled ranked list — same visuals as _shared's TopList, but with a per-row
// onItemClick so each ranked entry (bank / segment / vertical) can open its drilldown.
function DrilldownTopList({ title, sub, items, valueKey, nameKey, valueFmt, accentColor, onItemClick }: {
  title: string; sub?: string; items: any[]
  valueKey: string; nameKey: string
  valueFmt?: (v: number) => string
  accentColor?: string
  onItemClick?: (item: any) => void
}) {
  if (!items?.length) return null
  const fmt = valueFmt || fmtN
  const maxVal = Math.max(...items.map(i => num(i[valueKey])), 1)
  const accent = accentColor || C.primary
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="px-5 pt-4 pb-3">
        <div className="text-[13px] font-semibold tracking-tight text-slate-900">{title}</div>
        {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
      </div>
      <div className="divide-y divide-dashed divide-slate-100 px-[18px] pb-4">
        {items.slice(0, 8).map((item, i) => {
          const v = num(item[valueKey])
          const barW = ((v / maxVal) * 100).toFixed(1)
          return (
            <div
              key={i}
              onClick={onItemClick ? () => onItemClick(item) : undefined}
              className={`grid grid-cols-[28px_1fr_auto] items-center gap-2.5 py-2.5 ${onItemClick ? 'cursor-pointer rounded-lg hover:bg-slate-50' : ''}`}
            >
              <span className="font-mono text-[11px] font-semibold text-slate-400">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <div className="text-[13px] font-medium text-slate-900 truncate max-w-[200px]">
                  {item[nameKey] || '—'}
                </div>
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${barW}%`, background: accent }} />
                </div>
              </div>
              <span className="text-[13px] font-semibold tabular-nums text-slate-900 whitespace-nowrap">{fmt(v)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Normalize /reports/emdbg row fields to the keys used across this view
function normalizeRow(r: any) {
  return {
    ...r,
    ref: r.reference_num,
    client: r.client_name || r.customer_name,
    type: r.instrument_type,
    bank: r.bank_name,
    days_left: r.days_to_expiry,
  }
}

export default function EMDBGReportView() {
  const { singular: emdbgSingular } = useModuleName('emdbg')
  const { singular: customerSingular } = useModuleName('customers')
  const { singular: tenderSingular } = useModuleName('tenders')
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
      const res = await api.get(`/reports/emdbg?${toBackendParams(f)}`)
      setRows((res.data?.data || []).map(normalizeRow))
    } catch { setRows([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    loadData(filters)
    api.get('/reports/emdbg/filter-options')
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

  const activeRows = useMemo(() => tableRows.filter(r => ['active', 'renewed'].includes((r.status || '').toLowerCase())), [tableRows])
  const expiredRows = useMemo(() => tableRows.filter(r => (r.status || '').toLowerCase() === 'expired' || (r.days_left != null && num(r.days_left) < 0)), [tableRows])
  const expiredCount = expiredRows.length
  const releasedRows = useMemo(() => tableRows.filter(r => (r.status || '').toLowerCase() === 'released'), [tableRows])
  const releasedCount = releasedRows.length
  const expiring7Rows = useMemo(() => tableRows.filter(r => r.days_left != null && num(r.days_left) >= 0 && num(r.days_left) <= 7), [tableRows])
  const expiring7 = expiring7Rows.length
  const expiring30Rows = useMemo(() => tableRows.filter(r => r.days_left != null && num(r.days_left) >= 0 && num(r.days_left) <= 30), [tableRows])
  const expiring30 = expiring30Rows.length
  const totalExposure = useMemo(() => activeRows.reduce((s, r) => s + num(r.amount), 0), [activeRows])
  const unpaidRows = useMemo(() => tableRows.filter(r => (r.finance_status || '').toLowerCase() !== 'paid'), [tableRows])

  const expiryBucketRows = useMemo(() => {
    const buckets: Record<string, any[]> = { 'Expired': [], '≤7 days': [], '8–15 days': [], '16–30 days': [], '31–60 days': [], '>60 days': [] }
    tableRows.forEach(r => {
      const dl = r.days_left != null ? num(r.days_left) : null
      if (dl === null) return
      if (dl < 0) buckets['Expired'].push(r)
      else if (dl <= 7) buckets['≤7 days'].push(r)
      else if (dl <= 15) buckets['8–15 days'].push(r)
      else if (dl <= 30) buckets['16–30 days'].push(r)
      else if (dl <= 60) buckets['31–60 days'].push(r)
      else buckets['>60 days'].push(r)
    })
    return buckets
  }, [tableRows])

  const expiryBuckets = useMemo(
    () => Object.entries(expiryBucketRows as Record<string, any[]>).map(([name, list]) => ({ name, value: list.length })),
    [expiryBucketRows],
  )

  const monthlyTrend = useMemo(() => {
    const m: Record<string, { issued: number; released: number }> = {}
    tableRows.forEach(r => {
      const key = (r.issued_date || '').slice(0, 7)
      if (!key) return
      if (!m[key]) m[key] = { issued: 0, released: 0 }
      m[key].issued++
      if ((r.status || '').toLowerCase() === 'released') m[key].released++
    })
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([name, v]) => ({ name, ...v }))
  }, [tableRows])

  const monthRows = useCallback(
    (monthKey: string, kind: 'issued' | 'released') => tableRows.filter(r => {
      if ((r.issued_date || '').slice(0, 7) !== monthKey) return false
      return kind === 'issued' || (r.status || '').toLowerCase() === 'released'
    }),
    [tableRows],
  )

  const typeBreakdown = useMemo(() => {
    const m: Record<string, { count: number; value: number }> = {}
    tableRows.forEach(r => {
      const t = r.type || 'Unknown'
      if (!m[t]) m[t] = { count: 0, value: 0 }
      m[t].count++; m[t].value += num(r.amount)
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value)
  }, [tableRows])

  const typeRows = useCallback(
    (typeName: string) => tableRows.filter(r => (r.type || 'Unknown') === typeName),
    [tableRows],
  )

  const bankExposure = useMemo(() => {
    const m: Record<string, { count: number; value: number }> = {}
    tableRows.forEach(r => {
      const b = r.bank || 'Unknown'
      if (!m[b]) m[b] = { count: 0, value: 0 }
      m[b].count++; m[b].value += num(r.amount)
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value)
  }, [tableRows])

  const customerExposure = useMemo(() => {
    const m: Record<string, { count: number; value: number }> = {}
    tableRows.forEach(r => {
      const c = r.client || 'Unknown'
      if (!m[c]) m[c] = { count: 0, value: 0 }
      m[c].count++; m[c].value += num(r.amount)
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value)
  }, [tableRows])

  const segmentExposure = useMemo(() => {
    const m: Record<string, { count: number; value: number }> = {}
    tableRows.forEach(r => {
      const s = r.customer_segment || 'Unclassified'
      if (!m[s]) m[s] = { count: 0, value: 0 }
      m[s].count++; m[s].value += num(r.amount)
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value)
  }, [tableRows])

  const verticalExposure = useMemo(() => {
    const m: Record<string, { count: number; value: number }> = {}
    tableRows.forEach(r => {
      const v = r.business_vertical || 'Unclassified'
      if (!m[v]) m[v] = { count: 0, value: 0 }
      m[v].count++; m[v].value += num(r.amount)
    })
    return Object.entries(m).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value)
  }, [tableRows])

  // ── Financial dashboard data: lifecycle value, category cards and expiry health ──
  const blockedAmount = useMemo(() => activeRows.reduce((s, r) => s + num(r.amount), 0), [activeRows])
  const releasedAmount = useMemo(() => releasedRows.reduce((s, r) => s + num(r.amount), 0), [releasedRows])
  const encashedRows = useMemo(() => tableRows.filter(r => (r.status || '').toLowerCase() === 'encashed'), [tableRows])
  const encashedAmount = useMemo(() => encashedRows.reduce((s, r) => s + num(r.amount), 0), [encashedRows])

  const expiryAmountBucketRows = useMemo(() => {
    const buckets: Record<string, any[]> = {
      '0–7 Days': [],
      '8–30 Days': [],
      '31–60 Days': [],
      '61–90 Days': [],
      '90+ Days': [],
    }
    tableRows.forEach(r => {
      const dl = r.days_left != null ? num(r.days_left) : null
      if (dl === null || dl < 0) return
      if (dl <= 7) buckets['0–7 Days'].push(r)
      else if (dl <= 30) buckets['8–30 Days'].push(r)
      else if (dl <= 60) buckets['31–60 Days'].push(r)
      else if (dl <= 90) buckets['61–90 Days'].push(r)
      else buckets['90+ Days'].push(r)
    })
    return buckets
  }, [tableRows])

  const expiryAmountBuckets = useMemo(
    () => Object.entries(expiryAmountBucketRows as Record<string, any[]>).map(([name, list]) => ({
      name,
      value: list.reduce((s, r) => s + num(r.amount), 0),
      rows: list,
    })),
    [expiryAmountBucketRows],
  )

  const upcoming90Amount = useMemo(
    () => expiryAmountBuckets
      .filter(b => b.name !== '90+ Days')
      .reduce((s, b) => s + b.value, 0),
    [expiryAmountBuckets],
  )
  const after90Amount = useMemo(
    () => expiryAmountBuckets.find(b => b.name === '90+ Days')?.value || 0,
    [expiryAmountBuckets],
  )

  const categoryStats = useMemo(() => {
    const categories: InstrumentCategory[] = ['Tender Fee', 'EMD', 'PBG']

    return categories.map(cat => {
      const recs = tableRows.filter(r => getInstrumentCategory(r.type) === cat)
      const conf = CATEGORY_CONFIG[cat]
      const paidRows = recs.filter(r => (r.finance_status || 'unpaid').toLowerCase() === 'paid')
      const activeRows = recs.filter(r => ['active', 'renewed'].includes((r.status || '').toLowerCase()))
      const releasedRows = recs.filter(r => (r.status || '').toLowerCase() === 'released')
      const encashedRows = recs.filter(r => (r.status || '').toLowerCase() === 'encashed')
      const totalAmt = recs.reduce((s, r) => s + num(r.amount), 0)
      const paidAmt = paidRows.reduce((s, r) => s + num(r.amount), 0)
      const balanceAmt = Math.max(totalAmt - paidAmt, 0)
      const paidPct = totalAmt > 0 ? Math.min(100, Math.round((paidAmt / totalAmt) * 1000) / 10) : 0
      const blockedAmt = activeRows.reduce((s, r) => s + num(r.amount), 0)
      const releasedAmt = releasedRows.reduce((s, r) => s + num(r.amount), 0)
      const encashedAmt = encashedRows.reduce((s, r) => s + num(r.amount), 0)

      const expiredExpiryRows = recs.filter(r =>
        (r.expiry_status || '').toLowerCase() === 'expired' ||
        (r.days_left != null && num(r.days_left) < 0),
      )
      const due30Rows = recs.filter(r => r.days_left != null && num(r.days_left) >= 0 && num(r.days_left) <= 30)
      const due90Rows = recs.filter(r => r.days_left != null && num(r.days_left) > 30 && num(r.days_left) <= 90)
      const safeRows = recs.filter(r => r.days_left != null && num(r.days_left) > 90)

      const expiryHealth = [
        { label: 'Expired', rows: expiredExpiryRows, color: '#ef4444' },
        { label: '0–30 Days', rows: due30Rows, color: '#f97316' },
        { label: '31–90 Days', rows: due90Rows, color: '#eab308' },
        { label: '90+ Days', rows: safeRows, color: '#22c55e' },
      ].map(item => ({
        ...item,
        count: item.rows.length,
        amount: item.rows.reduce((s, r) => s + num(r.amount), 0),
      }))

      const expiryHealthTotal = expiryHealth.reduce((s, item) => s + item.amount, 0)
      const isAtRisk = cat === 'PBG' && (expiredExpiryRows.length > 0 || due30Rows.length > 0)

      return {
        cat, conf, recs,
        activeRows, paidRows, releasedRows, encashedRows,
        totalAmt, paidAmt, balanceAmt, paidPct,
        blockedAmt, releasedAmt, encashedAmt,
        expiryHealth, expiryHealthTotal, isAtRisk,
      }
    })
  }, [tableRows])

  const financialLifecycleData = useMemo(
    () => categoryStats.map(item => ({
      name: item.conf.label,
      blocked: item.blockedAmt,
      released: item.releasedAmt,
      encashed: item.encashedAmt,
      blockedRows: item.activeRows,
      releasedRows: item.releasedRows,
      encashedRows: item.encashedRows,
    })),
    [categoryStats],
  )

  const lifecycleTrackedAmount = blockedAmount + releasedAmount + encashedAmount

  const expiredNotReleasedRows = useMemo(
    () => tableRows.filter(r => num(r.days_left) < 0 && (r.status || '').toLowerCase() !== 'released' && (r.return_status || '').toLowerCase() !== 'released'),
    [tableRows],
  )

  const insights: InsightItem[] = useMemo(() => {
    const items: InsightItem[] = []
    const topBank = bankExposure[0]
    const total = bankExposure.reduce((s, b) => s + b.value, 0)
    if (topBank) items.push({
      title: 'Highest bank exposure', tone: 'warn',
      detail: `${topBank.name} holds the largest share of total instrument exposure`,
      value: `${fmtRsL(topBank.value)} (${pct(topBank.value, total)}%)`,
      onClick: () => openList(topBank.name, 'Instruments contributing to this bank’s exposure', tableRows.filter(r => (r.bank || 'Unknown') === topBank.name)),
    })
    const topCustomer = customerExposure[0]
    if (topCustomer) items.push({
      title: 'Largest blocked amount', tone: 'info',
      detail: `${topCustomer.name} has the highest instrument exposure among customers`,
      value: fmtRsL(topCustomer.value),
      onClick: () => openList(topCustomer.name, 'Instruments held by this customer', tableRows.filter(r => (r.client || 'Unknown') === topCustomer.name)),
    })
    const unpaidValue = unpaidRows.reduce((s, r) => s + num(r.amount), 0)
    items.push({
      title: 'Biggest pending refund', tone: unpaidRows.length ? 'neg' : 'pos',
      detail: `${fmtN(unpaidRows.length)} instruments awaiting finance settlement`,
      value: fmtRsL(unpaidValue),
      onClick: () => openList('Finance Unpaid', 'Instruments pending finance settlement', unpaidRows),
    })
    items.push({
      title: 'Upcoming renewals', tone: expiring30 > 0 ? 'warn' : 'pos',
      detail: 'Instruments expiring within the next 30 days',
      value: fmtN(expiring30),
      onClick: () => openList('Upcoming Renewals', 'Instruments expiring within the next 30 days', expiring30Rows),
    })
    items.push({
      title: 'Expired, not released', tone: expiredNotReleasedRows.length > 0 ? 'neg' : 'pos',
      detail: 'Expired instruments still pending release/return action',
      value: fmtN(expiredNotReleasedRows.length),
      onClick: () => openList('Expired, Not Released', 'Expired instruments still pending release/return action', expiredNotReleasedRows),
    })
    return items
  }, [bankExposure, customerExposure, unpaidRows, expiring30, expiring30Rows, expiredNotReleasedRows, tableRows])

  const cols: ColDef[] = [
    { key: 'ref', label: 'Ref No', render: v => <span className="font-mono text-[10px] text-slate-400">{v || '—'}</span> },
    { key: 'client', label: customerSingular, render: v => <span className="font-semibold text-slate-900">{v || '—'}</span> },
    { key: 'tender_num', label: `${tenderSingular} No`, render: v => <span className="font-mono text-[10px] text-slate-500">{v || '—'}</span> },
    { key: 'type', label: 'Type', render: v => v ? <Badge text={v} tone="info" dot={false} /> : null },
    { key: 'amount', label: 'Amount ₹', money: true, align: 'right' },
    { key: 'bank', label: 'Bank', render: v => v ? <span className="text-slate-700">{v}</span> : <span className="text-slate-300">—</span> },
    { key: 'expiry_date', label: 'Expiry', render: v => <span className="font-mono text-[11px] text-slate-500">{v || '—'}</span> },
    { key: 'days_left', label: 'Days Left', render: v => <DaysBadge days={v} />, align: 'center' },
    { key: 'status', label: 'Status', render: v => v ? <Badge text={v} /> : null },
    { key: 'finance_status', label: 'Finance', render: v => v ? <Badge text={v} tone={v.toLowerCase() === 'paid' ? 'pos' : v.toLowerCase() === 'overdue' ? 'neg' : 'warn'} /> : null },
    { key: 'return_status', label: 'Return', render: v => v ? <Badge text={v} tone="neutral" dot={false} /> : <span className="text-slate-300">—</span> },
  ]

  const openRow = (row: any) => setDrilldown({ entity: 'emdbg', id: row.id ?? row.ref, label: row.client, seedRow: row })

  const openList = (title: string, sub: string, list: any[]) => setListDrill({ title, sub, rows: list, columns: cols })

  if (loading && !rows.length) return <TabSkeleton />

  return (
    <div className="space-y-4">
     

      <AnalyticsFilterBar
        filters={filters} onChange={handleChange} onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() => exportRows(tableRows, cols, 'emdbg-instruments')}
        filterOptions={{
          owners: options?.users, statuses: options?.statuses, customers: options?.customers,
        }}
        loading={loading}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiCard
          label="Expiring ≤7 Days" value={fmtN(expiring7)} tone="neg" alert={expiring7 > 0} sub="Immediate action required"
          onClick={() => openList('Expiring ≤7 Days', 'Immediate action required', expiring7Rows)}
        />
        <KpiCard
          label="Total Exposure" value={fmtRsL(totalExposure)} tone="purple" sub={`${fmtN(tableRows.length)} instruments`}
          onClick={() => openList('Total Exposure', 'Active instruments contributing to total exposure', activeRows)}
        />
        <KpiCard
          label="Finance Unpaid" value={fmtN(unpaidRows.length)} tone="warn" alert={unpaidRows.length > 0} sub="Pending settlement"
          onClick={() => openList('Finance Unpaid', 'Pending settlement', unpaidRows)}
        />
      </div>

      {/* Financial instrument cards — redesigned to match the approved reference */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {categoryStats.map(item => {
          const {
            cat, conf, recs,
            activeRows: catActive, paidRows: catPaid, releasedRows: catReleased,
            totalAmt, paidAmt, balanceAmt, paidPct,
            expiryHealth, expiryHealthTotal, isAtRisk,
          } = item

          const lifecycleSteps = [
            { label: 'Active', value: catActive.length, rows: catActive },
            { label: 'Paid', value: catPaid.length, rows: catPaid },
            { label: 'Released', value: catReleased.length, rows: catReleased },
          ]

          return (
            <div
              key={cat}
              className="min-h-[400px] overflow-hidden rounded-[20px] border bg-white shadow-[0_8px_30px_rgba(15,23,42,0.07),0_1px_4px_rgba(15,23,42,0.04)]"
              style={{ borderColor: conf.border }}
            >
              <div className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl shadow-sm"
                      style={{ background: `linear-gradient(135deg, ${conf.accent}, ${conf.text})` }}
                    >
                      <conf.Icon size={20} className="text-white" strokeWidth={2} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-[15px] font-bold tracking-tight text-slate-900">{conf.label}</div>
                      <div className="mt-0.5 text-[11px] font-medium text-slate-500">{fmtN(recs.length)} instruments</div>
                    </div>
                  </div>

                  <div className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold ${isAtRisk ? 'bg-orange-50 text-orange-700' : 'bg-emerald-50 text-emerald-700'}`}>
                    {isAtRisk ? <AlertTriangle size={12} /> : <ShieldCheck size={12} />}
                    {isAtRisk ? 'At Risk' : 'Healthy'}
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-[minmax(0,1fr)_118px] items-center gap-3">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Total Value</div>
                    <div className="mt-1 text-[28px] font-black leading-none tracking-tight" style={{ color: conf.accent }}>
                      {fmtRsL(totalAmt)}
                    </div>
                    <div className="mt-5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400">Balance Amount</div>
                    <div className="mt-1 text-[16px] font-extrabold tabular-nums text-slate-800">{fmtRsL(balanceAmt)}</div>
                  </div>

                  <div className="relative h-[118px] w-[118px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={[
                            { name: 'Paid', value: paidAmt },
                            { name: 'Balance', value: balanceAmt },
                          ]}
                          dataKey="value"
                          cx="50%"
                          cy="50%"
                          innerRadius={40}
                          outerRadius={54}
                          startAngle={90}
                          endAngle={-270}
                          paddingAngle={totalAmt > 0 ? 1 : 0}
                          stroke="none"
                          isAnimationActive
                        >
                          <Cell fill={conf.accent} />
                          <Cell fill={conf.track} />
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                      <div className="text-[19px] font-black tabular-nums text-slate-900">{paidPct.toFixed(1)}%</div>
                      <div className="text-[10px] font-semibold text-slate-400">Paid</div>
                    </div>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2.5">
                  {lifecycleSteps.map(step => (
                    <button
                      key={step.label}
                      type="button"
                      onClick={() => openList(`${conf.label} — ${step.label}`, `${conf.label} instruments in this state`, step.rows)}
                      className="rounded-xl border px-2 py-2.5 text-center transition hover:-translate-y-0.5 hover:shadow-md"
                      style={{ backgroundColor: conf.soft, borderColor: conf.track }}
                    >
                      <div className="text-[18px] font-black tabular-nums" style={{ color: conf.accent }}>{step.value}</div>
                      <div className="mt-0.5 text-[10px] font-bold" style={{ color: conf.text }}>{step.label}</div>
                    </button>
                  ))}
                </div>

                <div className="mt-4 border-t border-slate-100 pt-4">
                  {cat !== 'PBG' ? (
                    <>
                      <div className="text-[10px] font-bold uppercase tracking-[0.09em] text-slate-400">Lifecycle</div>
                      <div className="relative mt-4 grid grid-cols-3">
                        <div className="absolute left-[16%] right-[16%] top-4 h-px bg-slate-200" />
                        {lifecycleSteps.map((step, index) => {
                          const reached = step.value > 0
                          return (
                            <button
                              key={step.label}
                              type="button"
                              onClick={() => openList(`${conf.label} — ${step.label}`, `${conf.label} instruments in this lifecycle stage`, step.rows)}
                              className="relative z-10 flex flex-col items-center gap-1.5"
                            >
                              <span
                                className="flex h-8 w-8 items-center justify-center rounded-full border-2 bg-white"
                                style={{ borderColor: reached ? conf.accent : '#cbd5e1', color: reached ? conf.accent : '#94a3b8' }}
                              >
                                {reached ? <CheckCircle2 size={17} /> : <span className="h-2 w-2 rounded-full bg-slate-300" />}
                              </span>
                              <span className="text-[10px] font-semibold text-slate-500">{step.label}</span>
                              <span className="text-[11px] font-black text-slate-800">{step.value}</span>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-[10px] font-bold uppercase tracking-[0.09em] text-slate-400">Expiry Health</div>
                      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-100">
                        {expiryHealth.map(expiry => (
                          <div
                            key={expiry.label}
                            style={{
                              width: `${expiryHealthTotal > 0 ? (expiry.amount / expiryHealthTotal) * 100 : 0}%`,
                              backgroundColor: expiry.color,
                            }}
                          />
                        ))}
                      </div>
                      <div className="mt-3 grid grid-cols-4 divide-x divide-slate-100">
                        {expiryHealth.map(expiry => (
                          <button
                            key={expiry.label}
                            type="button"
                            onClick={() => openList(`${conf.label} — ${expiry.label}`, `${conf.label} instruments in this expiry range`, expiry.rows)}
                            className="min-w-0 px-1 text-center hover:bg-slate-50"
                          >
                            <div className="truncate text-[9px] font-semibold text-slate-500">{expiry.label}</div>
                            <div className="mt-1 text-[10px] font-black tabular-nums" style={{ color: expiry.color }}>{fmtRsL(expiry.amount)}</div>
                            <div className="mt-0.5 text-[9px] font-semibold text-slate-400">({expiry.count})</div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Financial comparison row — redesigned stacked lifecycle and expiry charts */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="overflow-hidden rounded-[20px] border border-[#e5eaf2] bg-white shadow-[0_8px_30px_rgba(15,23,42,0.06),0_1px_4px_rgba(15,23,42,0.04)]">
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <div className="text-[13px] font-bold tracking-tight text-slate-900">Blocked vs Released vs Encashed</div>
              <div className="mt-0.5 text-[11px] text-slate-500">Lifecycle value grouped by instrument category</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-500">Instrument Type</div>
          </div>

          <div className="grid grid-cols-1 gap-4 p-5 2xl:grid-cols-[190px_minmax(0,1fr)]">
            <div className="flex flex-col justify-between gap-4">
              <div className="space-y-3">
                {[
                  { label: 'Blocked', amount: blockedAmount, color: '#3b82f6', rows: activeRows },
                  { label: 'Released', amount: releasedAmount, color: '#22c55e', rows: releasedRows },
                  { label: 'Encashed', amount: encashedAmount, color: '#f97316', rows: encashedRows },
                ].map(status => (
                  <button
                    key={status.label}
                    type="button"
                    onClick={() => openList(`${status.label} Instruments`, `All ${status.label.toLowerCase()} instruments`, status.rows)}
                    className="grid w-full grid-cols-[10px_1fr_auto] items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-slate-50"
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: status.color }} />
                    <span className="text-[11px] font-semibold text-slate-600">{status.label}</span>
                    <span className="text-right text-[11px] font-black tabular-nums text-slate-800">
                      {fmtRsL(status.amount)}
                      <span className="ml-1 font-semibold text-slate-400">({pct(status.amount, lifecycleTrackedAmount || 1)}%)</span>
                    </span>
                  </button>
                ))}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Total Tracked Value</div>
                <div className="mt-1 text-[20px] font-black tabular-nums text-slate-900">{fmtRsL(lifecycleTrackedAmount)}</div>
              </div>
            </div>

            <div className="h-[245px] min-w-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={financialLifecycleData} barSize={64} margin={{ top: 20, right: 10, bottom: 0, left: 0 }}>
                  <CartesianGrid {...CGRID} vertical={false} />
                  <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 10 }} axisLine={{ stroke: '#d8dee8' }} tickLine={false} />
                  <YAxis
                    tick={{ ...AXIS_Y, fontSize: 9 }}
                    tickFormatter={(value: number) => fmtRsL(num(value))}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <Tooltip content={<ChartTip money />} />
                  <Bar
                    dataKey="blocked"
                    name="Blocked"
                    stackId="financial"
                    fill="#3b82f6"
                    cursor="pointer"
                    onClick={(bar: any) => {
                      const data = bar?.payload || bar
                      openList(`${data.name} — Blocked`, 'Active or renewed instruments in this category', data.blockedRows || [])
                    }}
                  >
                    <LabelList dataKey="blocked" position="center" fill="#ffffff" fontSize={9} fontWeight={700} formatter={(value: any) => num(value) > 0 ? fmtRsL(num(value)) : ''} />
                  </Bar>
                  <Bar
                    dataKey="released"
                    name="Released"
                    stackId="financial"
                    fill="#22c55e"
                    cursor="pointer"
                    onClick={(bar: any) => {
                      const data = bar?.payload || bar
                      openList(`${data.name} — Released`, 'Released instruments in this category', data.releasedRows || [])
                    }}
                  >
                    <LabelList dataKey="released" position="center" fill="#ffffff" fontSize={9} fontWeight={700} formatter={(value: any) => num(value) > 0 ? fmtRsL(num(value)) : ''} />
                  </Bar>
                  <Bar
                    dataKey="encashed"
                    name="Encashed"
                    stackId="financial"
                    fill="#f97316"
                    radius={[5, 5, 0, 0]}
                    cursor="pointer"
                    onClick={(bar: any) => {
                      const data = bar?.payload || bar
                      openList(`${data.name} — Encashed`, 'Encashed instruments in this category', data.encashedRows || [])
                    }}
                  >
                    <LabelList dataKey="encashed" position="center" fill="#ffffff" fontSize={9} fontWeight={700} formatter={(value: any) => num(value) > 0 ? fmtRsL(num(value)) : ''} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-[20px] border border-[#e5eaf2] bg-white shadow-[0_8px_30px_rgba(15,23,42,0.06),0_1px_4px_rgba(15,23,42,0.04)]">
          <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <div className="text-[13px] font-bold tracking-tight text-slate-900">Upcoming Expiry Amount</div>
              <div className="mt-0.5 text-[11px] text-slate-500">Instrument value grouped by remaining expiry window</div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-600">Next 90 Days</div>
          </div>

          <div className="p-5">
            <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_155px]">
              <div className="h-[235px] min-w-0">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={expiryAmountBuckets} barSize={42} margin={{ top: 28, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="expiryAmountPurple" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8b5cf6" stopOpacity={1} />
                        <stop offset="100%" stopColor="#6d28d9" stopOpacity={0.86} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...CGRID} vertical={false} />
                    <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d8dee8' }} tickLine={false} />
                    <YAxis
                      tick={{ ...AXIS_Y, fontSize: 9 }}
                      tickFormatter={(value: number) => fmtRsL(num(value))}
                      axisLine={false}
                      tickLine={false}
                      width={56}
                    />
                    <Tooltip content={<ChartTip money />} />
                    <Bar
                      dataKey="value"
                      name="Expiry Amount"
                      fill="url(#expiryAmountPurple)"
                      radius={[5, 5, 0, 0]}
                      cursor="pointer"
                      onClick={(bar: any) => {
                        const data = bar?.payload || bar
                        openList(data.name, 'Instruments expiring in this window', data.rows || expiryAmountBucketRows[data.name] || [])
                      }}
                    >
                      <LabelList dataKey="value" position="top" fill="#4c1d95" fontSize={9} fontWeight={800} formatter={(value: any) => num(value) > 0 ? fmtRsL(num(value)) : ''} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-2 gap-2 2xl:grid-cols-1">
                <div className="rounded-xl border border-violet-100 bg-violet-50/70 p-3">
                  <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-violet-500">0–90 Days</div>
                  <div className="mt-1 text-[18px] font-black tabular-nums text-violet-700">{fmtRsL(upcoming90Amount)}</div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-400">90+ Days</div>
                  <div className="mt-1 text-[18px] font-black tabular-nums text-slate-800">{fmtRsL(after90Amount)}</div>
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 divide-x divide-violet-100 rounded-xl border border-violet-100 bg-violet-50/50 px-3 py-2.5">
              <div className="pr-3">
                <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-400">Total Upcoming (0–90)</div>
                <div className="mt-0.5 text-[13px] font-black text-violet-700">{fmtRsL(upcoming90Amount)}</div>
              </div>
              <div className="pl-3">
                <div className="text-[9px] font-bold uppercase tracking-[0.08em] text-slate-400">Long-term Exposure</div>
                <div className="mt-0.5 text-[13px] font-black text-violet-700">{fmtRsL(after90Amount)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.9fr_1.3fr_0.9fr]">
        {/* Left column — release status + bank ranking + insights */}
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
            <div className="mb-2 text-[13px] font-semibold tracking-tight text-slate-900">Release Status</div>
            <div
              onClick={() => openList('Active Instruments', 'Instruments currently active or renewed', activeRows)}
              className="cursor-pointer rounded-lg transition hover:bg-slate-50"
            >
              <StatsRow label="Active" value={fmtN(activeRows.length)} pctVal={pct(activeRows.length, tableRows.length || 1)} color={C.pos} />
            </div>
            <div
              onClick={() => openList('Released Instruments', 'Instruments released', releasedRows)}
              className="cursor-pointer rounded-lg transition hover:bg-slate-50"
            >
              <StatsRow label="Released" value={fmtN(releasedCount)} pctVal={pct(releasedCount, tableRows.length || 1)} color={C.info} />
            </div>
            <div
              onClick={() => openList('Expired Instruments', 'Instruments expired', expiredRows)}
              className="cursor-pointer rounded-lg transition hover:bg-slate-50"
            >
              <StatsRow label="Expired" value={fmtN(expiredCount)} pctVal={pct(expiredCount, tableRows.length || 1)} color={C.neg} />
            </div>
          </div>
          <DrilldownTopList
            title="Bank-wise Exposure" sub="Top banks by total value" items={bankExposure.slice(0, 6)} nameKey="name" valueKey="value" valueFmt={fmtRsL}
            onItemClick={item => openList(item.name, 'Instruments contributing to this bank’s exposure', tableRows.filter(r => (r.bank || 'Unknown') === item.name))}
          />
          <InsightGrid items={insights.slice(0, 3)} cols={1} />
        </div>

        {/* Middle column — hero charts */}
        <div className="space-y-4">
          <ChartShell title="Expiry Risk Timeline" sub="Instruments by days-to-expiry bucket" height={280}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={expiryBuckets} barSize={34} margin={{ top: 16, right: 8, bottom: 20, left: -10 }}>
                <CartesianGrid {...CGRID} />
                <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} angle={-25} textAnchor="end" />
                <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
                <Tooltip content={<ChartTip />} />
                <Bar
                  dataKey="value" name="Count" radius={[4, 4, 0, 0]} cursor="pointer"
                  onClick={(b: any) => openList(b.name, 'Instruments by days-to-expiry bucket', expiryBucketRows[b.name] || [])}
                >
                  {expiryBuckets.map((b, i) => <Cell key={i} fill={BUCKET_COLORS[b.name] || C.info} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartShell>

          <ChartShell title="Monthly Issued vs Released" sub="Trend over the last 12 months" height={260}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthlyTrend} margin={{ top: 16, right: 8, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="emdIssuedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.primary} stopOpacity={0.25} /><stop offset="95%" stopColor={C.primary} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="emdReleasedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={C.pos} stopOpacity={0.2} /><stop offset="95%" stopColor={C.pos} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...CGRID} />
                <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} />
                <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={28} />
                <Tooltip content={<ChartTip />} />
                <Area
                  dataKey="issued" name="Issued" stroke={C.primary} strokeWidth={2} fill="url(#emdIssuedGrad)" dot={false}
                  activeDot={{ r: 4, cursor: 'pointer', onClick: (_e: any, p: any) => openList(`Issued — ${p.payload.name}`, 'Instruments issued in this month', monthRows(p.payload.name, 'issued')) }}
                />
                <Area
                  dataKey="released" name="Released" stroke={C.pos} strokeWidth={2} fill="url(#emdReleasedGrad)" dot={false}
                  activeDot={{ r: 4, cursor: 'pointer', onClick: (_e: any, p: any) => openList(`Released — ${p.payload.name}`, 'Instruments released in this month', monthRows(p.payload.name, 'released')) }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartShell>
        </div>

        {/* Right column — risk score + type mix */}
        <div className="space-y-4">
          <div
            onClick={() => openList('Financial Risk Score', 'Active instruments expiring ≤30 days', expiring30Rows)}
            className="cursor-pointer rounded-2xl transition hover:-translate-y-0.5"
          >
            <GaugeCard title="Financial Risk Score" sub="Active instruments expiring ≤30 days" value={expiring30} max={activeRows.length || 1} label="At Risk" tone={expiring30 > 0 ? 'warn' : 'pos'} height={230} />
          </div>
          <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
            <div className="mb-2.5 text-[13px] font-semibold tracking-tight text-slate-900">Instrument Type Mix</div>
            <div className="grid grid-cols-2 gap-2.5">
              {typeBreakdown.slice(0, 2).map(t => (
                <div
                  key={t.name}
                  onClick={() => openList(t.name, 'Instruments of this type', typeRows(t.name))}
                  className="cursor-pointer rounded-xl border border-slate-200 bg-slate-50/60 p-3 transition hover:border-slate-300 hover:bg-slate-100/70"
                >
                  <div className="text-[9.5px] font-bold uppercase tracking-wide text-slate-400">{t.name}</div>
                  <div className="mt-1.5 text-[18px] font-bold tabular-nums text-slate-900">{fmtN(t.count)}</div>
                  <div className="mt-1 text-[10.5px] font-semibold text-slate-500">{fmtRsL(t.value)}</div>
                </div>
              ))}
            </div>
          </div>
          <InsightGrid items={insights.slice(3)} cols={1} />
        </div>
      </div>

   

      <DistributionSection
        rows={rows}
        config={{ bu: 'donut', bv: 'lollipop', src: 'bubble', seg: 'trend' }}
        module={emdbgSingular}
        getBU={r => r.business_vertical || 'Unclassified'}
        getBV={r => r.business_vertical_group || r.business_vertical || 'Unclassified'}
        getSrc={r => r.source_portal || 'Other'}
        getSeg={r => r.customer_segment || 'Unclassified'}
        getResult={r => r.status === 'Released' ? 'Won' : r.status === 'Expired' ? 'Lost' : r.status || ''}
        getValue={r => Number(r.amount || 0)}
        onOpenRows={openList}
      />

      <Section idx="03" title={`${emdbgSingular} Risk Control Report`} desc="Expiry, finance and release action tracking — click a row for details" />
      <DataTable data={tableRows} columns={cols as any} title="emdbg-instruments" onRowClick={openRow} showExport showColumnToggle />

      <RecordViewPanel request={drilldown} onClose={() => setDrilldown(null)} />

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