import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Calendar, Check, ChevronDown, Copy, Download, FileSpreadsheet, FileText, MoreVertical, Printer, TrendingDown, TrendingUp, X } from 'lucide-react'
import { PRESETS } from './shared/filterConfigs'
import type { Column } from '@/components/ui/DataTable'
import { formatTableDateValue, isDateLikeValue } from '@/utils/date'

export const fmtCur = (v: unknown) => {
  const n = Number(v)
  if (v == null || v === '' || Number.isNaN(n)) return '-'
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`
  return `₹${n.toLocaleString('en-IN')}`
}

export const fmtNum = (v: unknown) => {
  const n = Number(v)
  return Number.isNaN(n) ? '-' : n.toLocaleString('en-IN')
}

export const fmtPct = (v: unknown) => {
  const n = Number(v)
  return Number.isNaN(n) ? '-' : `${n.toFixed(1)}%`
}

export function TrendBadge({ v }: { v: number | null | undefined }) {
  if (v == null) return null
  const up = v >= 0
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
        up ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'
      }`}
    >
      {up ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
      {Math.abs(v).toFixed(1)}%
    </span>
  )
}

export function KpiCard({
  label,
  value,
  trend,
  icon,
  color,
  sub,
  onClick,
}: {
  label: string
  value: string
  trend?: number | null
  icon: ReactNode
  color: string
  sub?: string
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl border bg-white p-4 ${color} ${
        onClick ? 'cursor-pointer transition hover:-translate-y-0.5 hover:shadow-md' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="mb-1 truncate text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
          <p className="text-2xl font-bold leading-none text-gray-900">{value}</p>
          {sub && <p className="mt-1 text-[11px] text-gray-400">{sub}</p>}
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
          <div className="rounded-lg bg-gray-50 p-2">{icon}</div>
          <TrendBadge v={trend} />
        </div>
      </div>
    </div>
  )
}

export function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { id: string | number; name: string }[]
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = value ? value.split(',').filter(Boolean) : []

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(Array.from(next).join(','))
  }

  return (
    <div className="relative">
      <label className="mb-1 block text-[13px] font-medium text-gray-700">{label}</label>
      <div
        className="flex h-9 w-full cursor-pointer select-none items-center justify-between rounded-lg border border-gray-200 px-3 text-[13px] text-gray-900"
        onClick={() => setOpen(v => !v)}
      >
        <span className={selected.length ? 'text-gray-900' : 'text-gray-400'}>
          {selected.length === 0
            ? 'All'
            : selected.length === 1
              ? (options.find(o => String(o.id) === selected[0])?.name || selected[0])
              : `${selected.length} selected`}
        </span>
        <ChevronDown size={13} className="flex-shrink-0 text-gray-400" />
      </div>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-52 w-full min-w-[180px] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl">
          {options.map(option => {
            const id = String(option.id)
            const checked = selected.includes(id)
            return (
              <div
                key={id}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-xs ${
                  checked ? 'bg-blue-50 text-blue-800' : 'text-gray-700 hover:bg-blue-50'
                }`}
                onClick={() => toggle(id)}
              >
                <div
                  className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border ${
                    checked ? 'border-blue-600 bg-blue-600' : 'border-gray-300'
                  }`}
                >
                  {checked && (
                    <svg viewBox="0 0 10 8" className="h-2.5 w-2.5 fill-white">
                      <path d="M1 4l3 3 5-6" />
                    </svg>
                  )}
                </div>
                {option.name}
              </div>
            )
          })}
          {selected.length > 0 && (
            <div className="border-t border-gray-100 p-2">
              <button
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="w-full text-center text-xs text-gray-500 hover:text-red-500"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function Chip({ label, onRemove, tone }: { label: string; onRemove: () => void; tone?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        tone || 'border-slate-200 bg-slate-50 text-slate-700'
      }`}
    >
      {label}
      <button onClick={onRemove}>
        <X size={10} />
      </button>
    </span>
  )
}

export function SaveModal({
  onSave,
  onClose,
}: {
  onSave: (name: string, shared: boolean) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="mb-4 text-base font-bold text-gray-900">Save View</h3>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          autoFocus
          placeholder="Name this report view"
          className="mb-3 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100"
        />
        <label className="mb-5 flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={shared}
            onChange={e => setShared(e.target.checked)}
            className="h-4 w-4 rounded"
          />
          <span className="text-sm text-gray-700">Share with team</span>
        </label>
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="h-9 flex-1 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => name.trim() && onSave(name.trim(), shared)}
            disabled={!name.trim()}
            className="h-9 flex-1 rounded-lg bg-[var(--color-primary)] text-sm font-medium text-white hover:brightness-95 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export function ReportDateRangeToolbar({
  preset,
  dateFrom,
  dateTo,
  onPresetChange,
  onDateFromChange,
  onDateToChange,
}: {
  preset: string
  dateFrom: string
  dateTo: string
  onPresetChange: (value: string) => void
  onDateFromChange: (value: string) => void
  onDateToChange: (value: string) => void
}) {
  const inputClass =
    'h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-800 shadow-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <select
          value={preset}
          onChange={e => onPresetChange(e.target.value)}
          className={`${inputClass} min-w-[156px] appearance-none pr-9`}
        >
          {PRESETS.map(option => (
            <option key={String(option.id)} value={String(option.id)}>
              {option.name}
            </option>
          ))}
        </select>
        <Calendar size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
      </div>
      {preset === 'custom' && (
        <>
          <input
            type="date"
            value={dateFrom}
            onChange={e => onDateFromChange(e.target.value)}
            className={`${inputClass} min-w-[168px]`}
          />
          <span className="text-sm font-medium text-slate-400">to</span>
          <input
            type="date"
            value={dateTo}
            onChange={e => onDateToChange(e.target.value)}
            className={`${inputClass} min-w-[168px]`}
          />
        </>
      )}
    </div>
  )
}

function formatExportCell(value: unknown, key?: string): string {
  if (value == null) return ''
  if (isDateLikeValue(value, key)) return formatTableDateValue(value, key)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function useOutsideClick(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose, ref])
}

export function ReportActionsMenu<T extends Record<string, unknown>>({
  title,
  exportFilename,
  columns,
  data,
}: {
  title: string
  exportFilename: string
  columns: Column<T>[]
  data: T[]
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClick(ref, () => setOpen(false))

  const exportColumns = columns.filter(column => !column.hidden && column.key !== 'id')
  const getRows = useCallback(
    () => data.map(row => exportColumns.map(column => formatExportCell(row[column.key], column.key))),
    [data, exportColumns],
  )

  const copyToClipboard = useCallback(async () => {
    const header = exportColumns.map(column => column.header).join('\t')
    const rows = getRows().map(row => row.join('\t'))
    const text = [header, ...rows].join('\n')

    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return
    }

    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }, [exportColumns, getRows])

  const exportCSV = useCallback(() => {
    const header = exportColumns.map(column => `"${column.header}"`).join(',')
    const rows = getRows().map(row => row.map(value => `"${value.replace(/"/g, '""')}"`).join(','))
    const csv = [header, ...rows].join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${exportFilename}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [exportColumns, exportFilename, getRows])

  const exportExcel = useCallback(() => {
    const header = `<tr>${exportColumns.map(column => `<th style="background:#1D4ED8;color:#fff;font-weight:bold;padding:8px 12px;border:1px solid #ddd">${column.header}</th>`).join('')}</tr>`
    const rows = getRows().map((row, index) =>
      `<tr style="background:${index % 2 === 0 ? '#fff' : '#F8FAFF'}">${row.map(value => `<td style="padding:6px 12px;border:1px solid #e5e7eb">${value}</td>`).join('')}</tr>`,
    )
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
      <head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
      <x:Name>${exportFilename}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
      </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
      <body><table>${header}${rows.join('')}</table></body></html>`
    const blob = new Blob([html], { type: 'application/vnd.ms-excel' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${exportFilename}.xls`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [exportColumns, exportFilename, getRows])

  const exportPDF = useCallback(() => {
    const header = exportColumns.map(column => `<th style="background:#1D4ED8;color:#fff;padding:8px 10px;font-size:11px;text-align:left;border:1px solid #ddd">${column.header}</th>`).join('')
    const rows = getRows().map((row, index) =>
      `<tr style="background:${index % 2 === 0 ? '#fff' : '#f8faff'}">${row.map(value => `<td style="padding:6px 10px;font-size:10px;border:1px solid #e5e7eb;color:#374151">${value || '-'}</td>`).join('')}</tr>`,
    )
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
      <style>@media print{@page{margin:1cm}body{font-family:Arial,sans-serif}}</style></head>
      <body style="font-family:Arial,sans-serif;padding:20px">
      <h2 style="color:#111827;font-size:16px;margin-bottom:4px">${title}</h2>
      <p style="color:#6b7280;font-size:11px;margin-bottom:16px">Generated: ${new Date().toLocaleString()} | ${data.length} records</p>
      <table style="width:100%;border-collapse:collapse"><thead><tr>${header}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></body></html>`)
    win.document.close()
    setTimeout(() => {
      win.focus()
      win.print()
      win.close()
    }, 350)
  }, [data.length, exportColumns, getRows, title])

  const handleCopy = async () => {
    await copyToClipboard()
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
    setOpen(false)
  }

  const items = [
    {
      icon: copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />,
      label: copied ? 'Copied!' : 'Copy to Clipboard',
      onClick: handleCopy,
      color: copied ? 'text-green-600' : 'text-slate-700',
    },
    {
      icon: <Printer size={14} />,
      label: 'Print',
      onClick: () => { exportPDF(); setOpen(false) },
      color: 'text-slate-700',
    },
    {
      icon: <FileText size={14} />,
      label: 'Export CSV',
      onClick: () => { exportCSV(); setOpen(false) },
      color: 'text-slate-700',
    },
    {
      icon: <FileSpreadsheet size={14} />,
      label: 'Export Excel',
      onClick: () => { exportExcel(); setOpen(false) },
      color: 'text-green-700',
    },
    {
      icon: <Download size={14} />,
      label: 'Export PDF',
      onClick: () => { exportPDF(); setOpen(false) },
      color: 'text-red-600',
    },
  ]

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(value => !value)}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 ${
          open ? 'border-blue-300 text-blue-700' : 'border-slate-200'
        }`}
        title="Export actions"
      >
        <MoreVertical size={15} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-slate-100 bg-white shadow-2xl">
          <div className="border-b border-slate-100 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Export Options</span>
          </div>
          {items.map(item => (
            <button
              key={item.label}
              onClick={item.onClick}
              className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs transition hover:bg-slate-50 ${item.color}`}
            >
              <span className="w-4 flex-shrink-0">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
