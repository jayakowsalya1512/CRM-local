/**
 * _shared.tsx — shared design tokens, utilities, and primitives for all dashboard tabs.
 * Import from here instead of duplicating across tab files.
 */
import { useState } from 'react'
import {
  Search, Download, ChevronUp, ChevronDown,
  ArrowUpRight, ArrowDownRight, Minus, Filter, X,
} from 'lucide-react'
import {
  Tooltip, ResponsiveContainer,
} from 'recharts'
export { Tooltip, ResponsiveContainer }

// ─── Design tokens ────────────────────────────────────────────────────────────
export const C = {
  ink: '#0b1220', ink2: '#334155', ink3: '#64748b', ink4: '#94a3b8',
  border: '#e6eaf1',
  primary: '#4338ca', primary2: '#6366f1',
  pos: '#059669', pos2: '#10b981',
  neg: '#dc2626',
  warn: '#d97706',
  info: '#0284c7',
} as const

export const CHART = [
  C.primary, C.pos, C.warn, C.info, '#db2777', '#7c3aed', C.neg,
  '#0891b2', '#d97706', '#65a30d', C.ink3,
]

// ─── Formatters ───────────────────────────────────────────────────────────────
export const fmtN   = (n: number) => (Number(n) || 0).toLocaleString('en-IN')
export const fmtRs  = (n: number) => `₹${fmtN(Math.round(n))}`
export const fmtRsL = (n: number) => {
  if (!n) return '₹0'
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`
  return fmtRs(n)
}
export const splitRs = (n: number): { val: string; unit: string } => {
  if (!n) return { val: '0', unit: '' }
  if (n >= 1e7) return { val: (n / 1e7).toFixed(1), unit: 'Cr' }
  if (n >= 1e5) return { val: (n / 1e5).toFixed(1), unit: 'L' }
  return { val: fmtN(Math.round(n)), unit: '' }
}
export const num = (v: any): number => Number(v) || 0
export const pct = (a: number, b: number) => b ? Math.round((a / b) * 100) : 0

// ─── Chart tooltip ────────────────────────────────────────────────────────────
export function ChartTip({ active, payload, label, money }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-white/10 bg-[#0b1220] px-3 py-2.5 text-xs text-white shadow-2xl min-w-[120px]">
      {label && <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-400 font-semibold">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-2 w-2 rounded-sm flex-shrink-0" style={{ background: p.color || p.fill }} />
          <span className="text-slate-400 truncate max-w-[100px]">{p.name}:</span>
          <span className="ml-auto font-semibold tabular-nums">{money ? fmtRsL(p.value) : fmtN(p.value ?? 0)}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Badge ────────────────────────────────────────────────────────────────────
export type Tone = 'pos' | 'neg' | 'warn' | 'info' | 'neutral' | 'dark' | 'purple'
export const TONE: Record<Tone, string> = {
  pos:     'text-emerald-700 bg-emerald-50 border-emerald-200',
  neg:     'text-red-700 bg-red-50 border-red-200',
  warn:    'text-amber-700 bg-amber-50 border-amber-200',
  info:    'text-sky-700 bg-sky-50 border-sky-200',
  neutral: 'text-slate-600 bg-slate-50 border-slate-200',
  dark:    'text-white bg-slate-900 border-slate-900',
  purple:  'text-purple-700 bg-purple-50 border-purple-200',
}
export const STATUS_TONE: Record<string, Tone> = {
  'Active':'pos','Won':'pos','Approved':'pos','Completed':'pos','Converted':'pos','Released':'pos',
  'Lost':'neg','Inactive':'neg','Churned':'neg','Rejected':'neg','Cancelled':'neg','Expired':'neg',
  'Pending':'warn','Overdue':'warn','Submitted':'info','Prospect':'info','Qualified':'info','Opportunity Created':'info',
  'Draft':'neutral','Aligned':'neutral',
}
export function Badge({ text, tone, dot = true }: { text: string; tone?: Tone; dot?: boolean }) {
  const t: Tone = tone ?? STATUS_TONE[text] ?? 'neutral'
  const dotColor: Record<Tone, string> = {
    pos: 'bg-emerald-500', neg: 'bg-red-500', warn: 'bg-amber-500',
    info: 'bg-sky-500', dark: 'bg-white/80', neutral: 'bg-slate-400', purple: 'bg-purple-500',
  }
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${TONE[t]}`}>
      {dot && <span className={`inline-block h-[5px] w-[5px] rounded-full flex-shrink-0 ${dotColor[t]}`} />}
      {text}
    </span>
  )
}

// ─── Delta ────────────────────────────────────────────────────────────────────
export function Delta({ value, label }: { value?: number; label?: string }) {
  if (value == null) return null
  const up = value > 0, flat = value === 0
  const cls = up ? 'text-emerald-700 bg-emerald-50 border-emerald-100' : flat ? 'text-slate-500 bg-slate-100 border-slate-200' : 'text-red-700 bg-red-50 border-red-100'
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${cls}`}>
      <Icon size={10} strokeWidth={3} />{Math.abs(value).toFixed(1)}%
      {label && <span className="ml-0.5 font-normal opacity-70">{label}</span>}
    </span>
  )
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
export type Tone2 = 'primary' | 'pos' | 'neg' | 'warn' | 'info' | 'purple'
const KPI_RAIL: Record<Tone2, string> = {
  primary: 'from-indigo-700 to-indigo-500',
  pos:     'from-emerald-600 to-emerald-500',
  neg:     'from-red-600 to-red-500',
  warn:    'from-amber-600 to-amber-500',
  info:    'from-sky-600 to-sky-500',
  purple:  'from-purple-700 to-purple-500',
}
const KPI_ICON_BG: Record<Tone2, string> = {
  primary: 'bg-indigo-50 text-indigo-600',
  pos:     'bg-emerald-50 text-emerald-600',
  neg:     'bg-red-50 text-red-600',
  warn:    'bg-amber-50 text-amber-600',
  info:    'bg-sky-50 text-sky-600',
  purple:  'bg-purple-50 text-purple-600',
}

export function KpiCard({
  label, value, unit, sub, delta, tone = 'primary', alert, spotlight, onClick, icon,
}: {
  label: string; value: string | number; unit?: string
  sub?: React.ReactNode; delta?: number
  tone?: Tone2; alert?: boolean; spotlight?: boolean
  onClick?: () => void
  icon?: React.ReactNode
}) {
  return (
    <div
      onClick={onClick}
      className={[
        'group relative overflow-hidden rounded-2xl border bg-white px-[18px] pb-4 pt-4 transition-all duration-200',
        'shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]',
        onClick ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_16px_40px_rgba(15,23,42,0.09)] hover:border-slate-300' : '',
        alert ? 'border-red-200 bg-gradient-to-b from-white to-red-50/40' : 'border-[#e6eaf1]',
        spotlight ? '!bg-gradient-to-br !from-[#1e3a5f] !to-indigo-900 !border-indigo-950 text-white' : '',
      ].join(' ')}
    >
      {/* color rail */}
      {!spotlight && (
        <span className={`absolute inset-x-0 top-0 h-[3px] rounded-t-2xl bg-gradient-to-r ${alert ? 'from-red-600 to-red-500' : KPI_RAIL[tone]}`} />
      )}

      {/* label row */}
      <div className={`flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.12em] ${spotlight ? 'text-white/60' : alert ? 'text-red-700' : 'text-slate-500'}`}>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-[5px] w-[5px] rounded-full flex-shrink-0 ${alert ? 'bg-red-500 animate-pulse' : spotlight ? 'bg-emerald-400' : 'bg-slate-300'}`} />
          {label}
        </div>
        {icon && <span className={`rounded-lg p-1.5 ${spotlight ? 'bg-white/10 text-white/80' : KPI_ICON_BG[tone]}`}>{icon}</span>}
      </div>

      {/* value */}
      <div className={`mt-3 text-[32px] font-bold leading-none tracking-tight tabular-nums ${alert ? 'text-red-700' : spotlight ? 'text-white' : 'text-slate-900'}`}>
        {value}
        {unit && <span className={`ml-0.5 text-lg font-semibold ${spotlight ? 'text-white/60' : 'text-slate-400'}`}>{unit}</span>}
      </div>

      {/* footer */}
      <div className={`mt-3 flex items-center gap-2 border-t pt-2.5 text-[11px] leading-snug ${spotlight ? 'border-white/10 text-white/60' : 'border-slate-100 text-slate-500'}`}>
        {delta != null && <Delta value={delta} />}
        {sub && <span className="truncate">{sub}</span>}
      </div>
    </div>
  )
}

// ─── Chart shell ──────────────────────────────────────────────────────────────
export function ChartShell({ title, sub, children, height = 220, action }: {
  title: string; sub?: string; children: React.ReactNode; height?: number; action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-2 px-5 pt-4 pb-3">
        <div>
          <div className="text-[13px] font-semibold tracking-tight text-slate-900">{title}</div>
          {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
        </div>
        {action}
      </div>
      <div className="px-3 pb-4" style={{ height }}>{children}</div>
    </div>
  )
}

// ─── Top list ─────────────────────────────────────────────────────────────────
export function TopList({ title, sub, items, valueKey, nameKey, subKey, valueFmt, accentColor, onItemClick }: {
  title: string; sub?: string; items: any[]
  valueKey: string; nameKey: string; subKey?: string
  valueFmt?: (v: number) => string
  accentColor?: string
  onItemClick?: (item: any, index: number) => void
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
              onClick={onItemClick ? () => onItemClick(item, i) : undefined}
              className={`grid grid-cols-[28px_1fr_auto] items-center gap-2.5 py-2.5 ${
                onItemClick ? 'cursor-pointer rounded-lg hover:bg-slate-50' : ''
              }`}
            >
              <span className="font-mono text-[11px] font-semibold text-slate-400">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <div className="text-[13px] font-medium text-slate-900 truncate max-w-[200px]">
                  {item[nameKey] || '—'}
                </div>
                {subKey && item[subKey] && (
                  <div className="mt-0.5 text-[11px] text-slate-500">{item[subKey]}</div>
                )}
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

// ─── Days badge ───────────────────────────────────────────────────────────────
export function DaysBadge({ days }: { days: number | null }) {
  if (days == null) return <span className="text-slate-400">—</span>
  if (days < 0)   return <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[10.5px] font-bold text-white uppercase tracking-wider">EXPIRED</span>
  if (days <= 7)  return <span className="rounded-full bg-red-50 border border-red-200 px-2 py-0.5 font-mono text-[10.5px] font-bold text-red-700">{days}d</span>
  if (days <= 30) return <span className="rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 font-mono text-[10.5px] font-bold text-amber-700">{days}d</span>
  return <span className="rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 font-mono text-[10.5px] font-bold text-emerald-700">{days}d</span>
}

// ─── Filter state & bar ───────────────────────────────────────────────────────
export interface FilterState {
  date_from: string; date_to: string; assigned_to: string
  status: string; result: string; state: string; country: string; customer_id: string
  group: string
}
export const EMPTY_FILTERS: FilterState = {
  date_from: '', date_to: '', assigned_to: '', status: '', result: '', state: '', country: '', customer_id: '',
  group: '',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">{label}</label>
      {children}
    </div>
  )
}
const INPUT_CLS = 'font-[inherit] text-xs text-slate-900 border border-slate-200 bg-slate-50 px-2.5 py-1.5 rounded-lg min-w-[136px] outline-none transition-all focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100'

export function FilterBar({ filters, onChange, onApply, onReset, filterOptions, loading }: {
  filters: FilterState
  onChange: (k: keyof FilterState, v: string) => void
  onApply: () => void
  onReset: () => void
  filterOptions: any
  loading: boolean
}) {
  const [open, setOpen] = useState(true)
  const activeCount = Object.values(filters).filter(v => v !== '').length
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between border-b border-slate-200/60 px-[18px] py-2.5">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
          <Filter size={11} />
          Filters
          {activeCount > 0 && (
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-mono text-[10px] tracking-wider text-indigo-700">
              {activeCount} active
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {activeCount > 0 && (
            <button onClick={onReset} className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-red-600 transition-colors">
              <X size={11} /> Clear all
            </button>
          )}
          <button onClick={() => setOpen(o => !o)} className="text-slate-400 hover:text-slate-700 transition-colors">
            {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="flex flex-wrap items-end gap-3 px-[18px] py-4">
          <Field label="From date">
            <input type="date" value={filters.date_from} onChange={e => onChange('date_from', e.target.value)} className={INPUT_CLS} />
          </Field>
          <Field label="To date">
            <input type="date" value={filters.date_to} onChange={e => onChange('date_to', e.target.value)} className={INPUT_CLS} />
          </Field>
          {filterOptions?.statuses?.length > 0 && (
            <Field label="Status">
              <select value={filters.status} onChange={e => onChange('status', e.target.value)} className={INPUT_CLS}>
                <option value="">All status</option>
                {filterOptions.statuses.map((s: string) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}
          {filterOptions?.results?.length > 0 && (
            <Field label="Result">
              <select value={filters.result} onChange={e => onChange('result', e.target.value)} className={INPUT_CLS}>
                <option value="">All results</option>
                {filterOptions.results.map((r: string) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
          )}
          {filterOptions?.states?.length > 0 && (
            <Field label="State">
              <select value={filters.state} onChange={e => onChange('state', e.target.value)} className={INPUT_CLS}>
                <option value="">All states</option>
                {filterOptions.states.map((s: string) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}
          {filterOptions?.groups?.length > 0 && (
            <Field label="Group / Team">
              <select value={filters.group} onChange={e => onChange('group', e.target.value)} className={INPUT_CLS}>
                <option value="">All groups</option>
                {filterOptions.groups.map((g: string) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          )}
          {filterOptions?.owners?.length > 0 && (
            <Field label="Assigned to">
              <select value={filters.assigned_to} onChange={e => onChange('assigned_to', e.target.value)} className={INPUT_CLS}>
                <option value="">All users</option>
                {filterOptions.owners.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
          )}
          <button
            onClick={onApply} disabled={loading}
            className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-slate-900 bg-slate-900 px-5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            {loading && <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />}
            Apply
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Export utility ───────────────────────────────────────────────────────────
export function exportRows(rows: any[], columns: { key: string; label: string }[], filename: string, format: 'csv' = 'csv') {
  const hdr = columns.map(c => c.label).join(',')
  const body = rows.map(r => columns.map(c => {
    const v = String(r[c.key] ?? '')
    return v.includes(',') ? `"${v}"` : v
  }).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([hdr + '\n' + body], { type: 'text/csv' }))
  a.download = `${filename || 'export'}.csv`
  a.click()
}

// ─── Data table ───────────────────────────────────────────────────────────────
export interface ColDef {
  key: string; label: string
  render?: (v: any, row: any) => React.ReactNode
  align?: 'left' | 'right' | 'center'
  money?: boolean
  width?: number
}

export function DataTable({ rows, columns, title, onExport, onRowClick }: {
  rows: any[]; columns: ColDef[]; title?: string; onExport?: () => void; onRowClick?: (row: any) => void
}) {
  const [search, setSearch]   = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage]       = useState(0)
  const PER = 20

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
    setPage(0)
  }

  const filtered = rows.filter(r =>
    Object.values(r).some(v => String(v ?? '').toLowerCase().includes(search.toLowerCase()))
  )
  const sorted = sortKey ? [...filtered].sort((a, b) => {
    const av = a[sortKey] ?? '', bv = b[sortKey] ?? ''
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return sortDir === 'asc' ? cmp : -cmp
  }) : filtered

  const pages = Math.ceil(sorted.length / PER)
  const visible = sorted.slice(page * PER, (page + 1) * PER)

  const exportCSV = () => exportRows(sorted, columns, title || 'export')

  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200/60 px-[18px] py-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0) }}
              placeholder="Search records…"
              className="w-60 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-7 pr-3 text-xs outline-none focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100"
            />
          </div>
          <span className="font-mono text-[11px] text-slate-500 tabular-nums">{fmtN(filtered.length)} records</span>
        </div>
        <button
          onClick={onExport || exportCSV}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition-all hover:border-slate-400 hover:text-slate-900"
        >
          <Download size={12} /> Export CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-slate-50/80">
              {columns.map(c => (
                <th
                  key={c.key}
                  onClick={() => handleSort(c.key)}
                  style={c.width ? { width: c.width } : undefined}
                  className={`cursor-pointer select-none whitespace-nowrap border-b border-slate-200 px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500 hover:text-slate-900 transition-colors
                    ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {sortKey === c.key && (sortDir === 'asc' ? <ChevronUp size={10} /> : <ChevronDown size={10} />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={columns.length} className="px-4 py-12 text-center text-sm text-slate-400">No records found</td></tr>
            ) : visible.map((row, i) => (
              <tr key={i} onClick={() => onRowClick?.(row)}
                className={`border-b border-slate-100 transition-colors hover:bg-slate-50/60 last:border-b-0 ${onRowClick ? 'cursor-pointer' : ''}`}>
                {columns.map(c => (
                  <td key={c.key} className={[
                    'px-3.5 py-2.5 align-middle text-slate-700',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : '',
                    c.money || c.align === 'right' ? 'font-mono tabular-nums' : '',
                  ].join(' ')}>
                    {c.render ? c.render(row[c.key], row) : c.money ? fmtRsL(num(row[c.key])) : String(row[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-200/60 px-[18px] py-2.5 text-[11px] text-slate-500">
          <span className="tabular-nums">Page {page + 1} of {pages} · {fmtN(sorted.length)} records</span>
          <div className="flex items-center gap-1">
            <PBtn onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>‹</PBtn>
            {[...Array(Math.min(5, pages))].map((_, i) => {
              const pg = Math.max(0, Math.min(page - 2, pages - 5)) + i
              return <PBtn key={pg} active={pg === page} onClick={() => setPage(pg)}>{pg + 1}</PBtn>
            })}
            <PBtn onClick={() => setPage(p => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>›</PBtn>
          </div>
        </div>
      )}
    </div>
  )
}

function PBtn({ children, onClick, active, disabled }: { children: React.ReactNode; onClick?: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={[
        'inline-flex h-7 w-7 items-center justify-center rounded-md border text-xs transition-colors',
        active ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400',
        disabled ? 'cursor-not-allowed opacity-40' : '',
      ].join(' ')}>
      {children}
    </button>
  )
}

// ─── Section heading ──────────────────────────────────────────────────────────
export function Section({ idx, title, desc, action }: {
  idx: string; title: string; desc?: string; action?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-mono text-[10px] tracking-wider text-slate-400 select-none">{idx}</span>
      <h2 className="m-0 text-[12px] font-bold uppercase tracking-[0.06em] text-slate-600">{title}</h2>
      <span className="h-px flex-1 bg-gradient-to-r from-slate-200 to-transparent" />
      {desc && <span className="text-xs text-slate-400">{desc}</span>}
      {action}
    </div>
  )
}

// ─── Stats row ────────────────────────────────────────────────────────────────
export function StatsRow({ label, value, pctVal, color, sub }: {
  label: React.ReactNode; value: React.ReactNode; pctVal?: number; color?: string; sub?: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-b border-dashed border-slate-100 py-2.5 last:border-b-0">
      <div className="text-[13px] text-slate-700">
        {label}
        {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
      </div>
      {pctVal != null ? (
        <div className="relative h-1.5 min-w-[60px] overflow-hidden rounded-full bg-slate-100">
          <div className="absolute left-0 top-0 h-full rounded-full transition-all duration-700" style={{ width: `${Math.min(100, Math.max(0, pctVal))}%`, background: color || C.primary }} />
        </div>
      ) : <div />}
      <div className="text-[13px] font-semibold tabular-nums text-slate-900 whitespace-nowrap">
        {value}
        {pctVal != null && <span className="ml-1.5 text-[11px] font-normal text-slate-400">{pctVal}%</span>}
      </div>
    </div>
  )
}

// ─── Module head banner ───────────────────────────────────────────────────────
export function ModuleHead({ icon, title, subtitle, stats, onRefresh, loading, onExport, extra }: {
  icon: React.ReactNode; title: string; subtitle?: string
  stats: { label: string; value: string; tone?: 'pos' | 'neg' | 'warn' | 'info' }[]
  onRefresh: () => void; loading: boolean; onExport?: () => void
  extra?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-[#e6eaf1] bg-gradient-to-b from-white to-slate-50/40 px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-3.5">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm text-slate-700 flex-shrink-0">
          {icon}
        </div>
        <div>
          <h1 className="m-0 text-[16px] font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <div className="mt-0.5 text-[11px] font-medium text-slate-500">{subtitle}</div>}
        </div>
      </div>
      <div className="flex items-center gap-6">
        {stats.map((s, i) => (
          <div key={i} className="text-center">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{s.label}</div>
            <div className={`mt-0.5 text-[20px] font-bold tabular-nums ${s.tone === 'pos' ? 'text-emerald-600' : s.tone === 'neg' ? 'text-red-600' : s.tone === 'warn' ? 'text-amber-600' : s.tone === 'info' ? 'text-sky-600' : 'text-slate-900'}`}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {onExport && (
          <button onClick={onExport} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-400 transition-all">
            <Download size={12} /> Export
          </button>
        )}
        <button onClick={onRefresh} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-400 transition-all disabled:opacity-50">
          <svg className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          Refresh
        </button>
        {extra}
      </div>
    </div>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────
export function TabSkeleton() {
  return (
    <div className="space-y-4 p-6">
      <div className="h-[68px] animate-pulse rounded-2xl bg-white shadow-sm" />
      <div className="h-12 animate-pulse rounded-2xl bg-white shadow-sm" />
      <div className="grid grid-cols-6 gap-3">
        {[...Array(6)].map((_, i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-white shadow-sm" style={{ animationDelay: `${i * 60}ms` }} />)}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => <div key={i} className="h-[260px] animate-pulse rounded-2xl bg-white shadow-sm" style={{ animationDelay: `${(i + 6) * 60}ms` }} />)}
      </div>
      <div className="h-[340px] animate-pulse rounded-2xl bg-white shadow-sm" />
    </div>
  )
}

// ─── Comparison table ─────────────────────────────────────────────────────────
export interface CompareRow {
  label: string
  current: number
  previous?: number
  fmt?: (v: number) => string
  tone?: 'pos' | 'neg' | 'warn' | 'info'
}

export function ComparisonPanel({ title, rows }: { title: string; rows: CompareRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="border-b border-slate-200/60 px-5 py-3.5">
        <div className="text-[13px] font-semibold tracking-tight text-slate-900">{title}</div>
        <div className="mt-0.5 text-[11px] text-slate-500">Current period vs previous</div>
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
            <th className="border-b border-slate-200 px-5 py-2.5 text-left">Metric</th>
            <th className="border-b border-slate-200 px-5 py-2.5 text-right">Current</th>
            {rows.some(r => r.previous != null) && (
              <th className="border-b border-slate-200 px-5 py-2.5 text-right">Previous</th>
            )}
            <th className="border-b border-slate-200 px-5 py-2.5 text-right">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const fmt = r.fmt || fmtN
            const hasPrev = r.previous != null
            const chg = hasPrev && r.previous ? ((r.current - r.previous) / r.previous) * 100 : null
            return (
              <tr key={i} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors">
                <td className="px-5 py-3 font-medium text-slate-700">{r.label}</td>
                <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-900">{fmt(r.current)}</td>
                {rows.some(row => row.previous != null) && (
                  <td className="px-5 py-3 text-right tabular-nums text-slate-500">{hasPrev ? fmt(r.previous!) : '—'}</td>
                )}
                <td className="px-5 py-3 text-right">
                  {chg != null ? <Delta value={chg} /> : <span className="text-slate-300">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Shared chart axis defaults ───────────────────────────────────────────────
export const AXIS_X  = { fontSize: 10, fill: C.ink3 } as const
export const AXIS_Y  = { fontSize: 10, fill: C.ink4 } as const
export const CGRID   = { strokeDasharray: '2 3' as const, stroke: '#e6eaf1', vertical: false as const }
