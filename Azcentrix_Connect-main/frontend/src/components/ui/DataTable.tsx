
import React, { useState, useMemo, useRef, useEffect, useCallback, useId } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronUp, ChevronDown, ChevronsUpDown,
  Search, X, ChevronLeft, ChevronRight,
  ChevronsLeft, ChevronsRight, Download,
  SlidersHorizontal, Eye, EyeOff, Copy,
  Printer, FileText, FileSpreadsheet, Filter,
  Check, MoreHorizontal,
} from 'lucide-react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { formatTableDateValue, isDateLikeValue } from '@/utils/date'
import notoSansRegularUrl from '@/assets/fonts/pdf/NotoSans-Regular.ttf?url'
import notoSansBoldUrl from '@/assets/fonts/pdf/NotoSans-Bold.ttf?url'
import api from '@/services/api'

// jsPDF's built-in fonts have no glyph for ₹ (U+20B9) — it prints as a
// garbled character. Noto Sans does, so it's embedded for PDF export only;
// CSV/Excel/print already render the real symbol fine via the browser/OS font.
let pdfFontsPromise: Promise<{ regular: string; bold: string }> | null = null

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function loadPdfFonts() {
  if (!pdfFontsPromise) {
    pdfFontsPromise = Promise.all([
      fetch(notoSansRegularUrl).then(r => r.arrayBuffer()).then(arrayBufferToBase64),
      fetch(notoSansBoldUrl).then(r => r.arrayBuffer()).then(arrayBufferToBase64),
    ]).then(([regular, bold]) => ({ regular, bold }))
  }
  return pdfFontsPromise
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Column<T> {
  key:          string
  header?:      string
  label?:       string
  render?:      (value: unknown, row: T) => React.ReactNode
  exportValue?: (row: T) => unknown
  sortable?:    boolean
  searchable?:  boolean
  searchKeys?:  string[]
  width?:       string
  minWidth?:    string
  align?:       'left' | 'center' | 'right'
  hidden?:      boolean
  pinned?:      boolean
}

interface DataTableProps<T> {
  columns:            Column<T>[]
  data:               T[]
  loading?:           boolean
  emptyMessage?:      string
  emptyIcon?:         React.ReactNode
  keyField?:          string
  onRowClick?:        (row: T) => void
  expandedRowKey?:    string | null
  renderExpandedRow?: (row: T) => React.ReactNode
  rowClassName?:      (row: T) => string
  compact?:           boolean
  maxHeight?:         string
  showSearch?:        boolean
  searchable?:         boolean
  onSearchChange?:    (v: string) => void
  searchValue?:       string
  searchPlaceholder?: string
  searchInputClassName?: string
  showExport?:        boolean
  showColumnToggle?:  boolean
  exportFilename?:    string
  exportSummaryLines?: string[]
  footer?:            React.ReactNode
  title?:             string
  subtitle?:          string
  toolbar?:           React.ReactNode
  toolbarVariant?:    'default' | 'compact'
  stickyHeader?:      boolean
  striped?:           boolean
  selectable?:        boolean
  onSelectionChange?: (rows: T[]) => void
  initialPageSize?:   number | 'All'
  pageSizeOptions?:   readonly (number | 'All')[]
  showPaginationWhenSinglePage?: boolean
}

type SortDir = 'asc' | 'desc' | null
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 'All'] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function useOutsideClick(ref: React.RefObject<HTMLElement>, fn: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fn()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [fn])
}

function formatCell(value: unknown, key?: string): string {
  if (value == null) return ''
  if (isDateLikeValue(value, key)) return formatTableDateValue(value, key)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ─── Export Engine ────────────────────────────────────────────────────────────

function getColumnTitle<T>(col: Column<T>) {
  return col.header || col.label || col.key
}

function isIdColumn(key?: string) {
  if (!key) return false
  const k = key.toLowerCase()
  return k === 'id' || /(^|_|-)ref($|_|-)|_id$|\bref_id\b|\bnum\b|number$|request_number|quotation_number|tender_num|opportunity_ref_id|claim_number|wo_no|wo_number|workorder_number/.test(k)
}

function useExport<T>(
  processed: T[],
  visibleColumns: Column<T>[],
  exportFilename: string,
  summaryLines: string[] = [],
) {
  const exportCols = useMemo(
    () => visibleColumns.filter(c => c.searchable !== false && (!!c.exportValue || !isIdColumn(c.key))),
    [visibleColumns]
  )

  const getRows = useCallback(() =>
    processed.map(row => exportCols.map(c =>
      c.exportValue
        ? formatCell(c.exportValue(row), c.key)
        : formatCell((row as Record<string, unknown>)[c.key], c.key)
    )),
    [processed, exportCols]
  )

  const copyToClipboard = useCallback(async () => {
    const header = exportCols.map(getColumnTitle).join('\t')
    const rows   = getRows().map(r => r.join('\t'))
    await navigator.clipboard.writeText([header, ...rows].join('\n'))
  }, [exportCols, getRows])

  const exportCSV = useCallback(() => {
    const header = exportCols.map(c => `"${getColumnTitle(c)}"`).join(',')
    const rows   = getRows().map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(','))
    const csv    = [header, ...rows].join('\n')
    const blob   = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
    const url    = URL.createObjectURL(blob)
    const a      = document.createElement('a')
    a.href = url; a.download = `${exportFilename}.csv`; a.click()
    URL.revokeObjectURL(url)
  }, [exportCols, getRows, exportFilename])

  const exportExcel = useCallback(async () => {
    // Build a simple XLSX using SheetJS-style base64 or just CSV with .xlsx extension
    // We'll build a proper HTML table that Excel opens natively
    const colCount = exportCols.length || 1
    const summary  = summaryLines.length
      ? `<tr><td colspan="${colCount}" style="padding:4px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#F8FAFF">${summaryLines.join(' &nbsp;·&nbsp; ')}</td></tr>`
      : ''
    const header = `<tr>${exportCols.map(c => `<th style="background:#1D4ED8;color:#fff;font-weight:bold;padding:8px 12px;border:1px solid #ddd">${getColumnTitle(c)}</th>`).join('')}</tr>`
    const rows   = getRows().map((r, i) =>
      `<tr style="background:${i % 2 === 0 ? '#fff' : '#F8FAFF'}">${r.map(v => `<td style="padding:6px 12px;border:1px solid #e5e7eb">${v}</td>`).join('')}</tr>`
    )
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
      <head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
      <x:Name>${exportFilename}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
      </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
      <body><table>${summary}${header}${rows.join('')}</table></body></html>`
    const blob = new Blob([html], { type: 'application/vnd.ms-excel' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `${exportFilename}.xls`; a.click()
    URL.revokeObjectURL(url)
  }, [exportCols, getRows, exportFilename, summaryLines])

  // Downloads an actual .pdf file (jsPDF + autoTable) — distinct from printTable
  // below, which opens the browser print dialog instead.
  const exportPDF = useCallback(async () => {
    const doc = new jsPDF({
      orientation: exportCols.length > 6 ? 'landscape' : 'portrait',
      unit: 'pt',
    })

    const { regular, bold } = await loadPdfFonts()
    doc.addFileToVFS('NotoSans-Regular.ttf', regular)
    doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal')
    doc.addFileToVFS('NotoSans-Bold.ttf', bold)
    doc.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold')
    doc.setFont('NotoSans', 'normal')

    doc.setFontSize(14)
    doc.text(exportFilename, 40, 32)
    doc.setFontSize(9)
    doc.setTextColor(107, 114, 128)
    doc.text(`Generated: ${new Date().toLocaleString()} · ${processed.length} records`, 40, 48)

    let startY = 60
    if (summaryLines.length) {
      doc.setFontSize(9)
      doc.setTextColor(55, 65, 81)
      doc.text(summaryLines.join('   ·   '), 40, 64)
      startY = 78
    }

    autoTable(doc, {
      startY,
      head: [exportCols.map(getColumnTitle)],
      body: getRows(),
      styles: { font: 'NotoSans', fontStyle: 'normal', fontSize: 8, cellPadding: 5 },
      headStyles: { font: 'NotoSans', fontStyle: 'bold', fillColor: [29, 78, 216], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 255] },
      theme: 'grid',
    })

    doc.save(`${exportFilename}.pdf`)
  }, [exportCols, getRows, exportFilename, processed.length, summaryLines])

  const printTable = useCallback(() => {
    const header = exportCols.map(c => `<th style="background:#1D4ED8;color:#fff;padding:8px 10px;font-size:11px;text-align:left;border:1px solid #ddd">${getColumnTitle(c)}</th>`).join('')
    const rows   = getRows().map((r, i) =>
      `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8faff'}">${r.map(v => `<td style="padding:6px 10px;font-size:10px;border:1px solid #e5e7eb;color:#374151">${v || '—'}</td>`).join('')}</tr>`
    )
    const win = window.open('', '_blank')
    if (!win) return
    win.document.write(`<!DOCTYPE html><html><head><title>${exportFilename}</title>
      <style>@media print{@page{margin:1cm}body{font-family:Arial,sans-serif}}</style></head>
      <body style="font-family:Arial,sans-serif;padding:20px">
      <h2 style="color:#111827;font-size:16px;margin-bottom:4px">${exportFilename}</h2>
      <p style="color:#6b7280;font-size:11px;margin-bottom:16px">Generated: ${new Date().toLocaleString()} · ${processed.length} records</p>
      <table style="width:100%;border-collapse:collapse"><thead><tr>${header}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></body></html>`)
    win.document.close()
    setTimeout(() => { win.focus(); win.print(); win.close() }, 500)
  }, [exportCols, getRows, exportFilename, processed.length])

  return { copyToClipboard, exportCSV, exportExcel, exportPDF, printTable }
}

// ─── Export Menu ──────────────────────────────────────────────────────────────

export function ExportMenu<T>({
  processed, visibleColumns, exportFilename, summaryLines,
}: {
  processed: T[]; visibleColumns: Column<T>[]; exportFilename: string; summaryLines?: string[]
}) {
  const [open, setOpen]   = useState(false)
  const [copied, setCopied] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Portal'd to <body> with position:fixed — this menu previously rendered
  // absolutely inside the table's own rounded-corner card (overflow-hidden),
  // so a short table (e.g. a single row) clipped the bottom items (Export
  // Excel/PDF) since the card's box was shorter than the dropdown's height.
  useEffect(() => {
    if (!open) return

    const updatePosition = () => {
      const rect = btnRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = 192 // w-48
      setMenuPos({
        top: rect.bottom + 8,
        left: Math.min(rect.right - width, window.innerWidth - width - 8),
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('mousedown', handleOutsideClick)
    }
  }, [open])

  const { copyToClipboard, exportCSV, exportExcel, exportPDF, printTable } =
    useExport(processed, visibleColumns, exportFilename, summaryLines)

  // Exporting happens entirely client-side (data already on screen), so there's
  // no server request to log by itself — self-report it to the Audit Log,
  // best-effort, without blocking or surfacing errors on the export itself.
  const logExport = (format: string) => {
    api.post('/audit-logs/client-event', {
      module: exportFilename.replace(/[^a-z0-9]+/gi, '_').toLowerCase() || 'export',
      action: 'export',
      record_name: `${exportFilename} (${format})`,
      description: `Exported ${processed.length} record${processed.length !== 1 ? 's' : ''} as ${format}`,
    }).catch(() => {})
  }

  const handleCopy = async () => {
    await copyToClipboard()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    setOpen(false)
  }

  const items = [
    {
      icon: copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />,
      label: copied ? 'Copied!' : 'Copy to Clipboard',
      onClick: handleCopy,
      color: copied ? 'text-green-600' : 'text-gray-700',
    },
    {
      icon: <Printer size={13} />,
      label: 'Print',
      onClick: () => { printTable(); setOpen(false) },
      color: 'text-gray-700',
    },
    {
      icon: <FileText size={13} />,
      label: 'Export CSV',
      onClick: () => { exportCSV(); logExport('CSV'); setOpen(false) },
      color: 'text-gray-700',
    },
    {
      icon: <FileSpreadsheet size={13} />,
      label: 'Export Excel',
      onClick: () => { exportExcel(); logExport('Excel'); setOpen(false) },
      color: 'text-green-700',
    },
    {
      icon: <Download size={13} />,
      label: 'Export PDF',
      onClick: () => { exportPDF(); logExport('PDF'); setOpen(false) },
      color: 'text-red-600',
    },
  ]

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-all
          ${open
            ? 'bg-blue-50 border-blue-300 text-blue-700'
            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300'}`}
      >
        <Download size={13} />
        Export
        <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
          className="z-[100300] w-48 bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-gray-50">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Export Options</span>
          </div>
          {items.map((item, i) => (
            <button key={i} onClick={item.onClick}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs hover:bg-gray-50 transition-colors ${item.color}`}>
              <span className="w-4 flex-shrink-0">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

// ─── Column Toggle ────────────────────────────────────────────────────────────

function ColumnToggle<T>({
  columns, hidden, onToggle,
}: {
  columns: Column<T>[]; hidden: Set<string>; onToggle: (key: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClick(ref, () => setOpen(false))
  const toggleable = columns.filter(c => !c.pinned)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border transition-all
          ${open
            ? 'bg-blue-50 border-blue-300 text-blue-700'
            : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300'}`}
      >
        <SlidersHorizontal size={13} />
        Columns
        {hidden.size > 0 && (
          <span className="ml-0.5 w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {hidden.size}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-52 bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden">
          <div className="px-3 py-2.5 border-b border-gray-100 flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Toggle Columns</span>
            {hidden.size > 0 && (
              <button
                onClick={() => toggleable.forEach(c => hidden.has(c.key) && onToggle(c.key))}
                className="text-[10px] font-semibold text-blue-600 hover:text-blue-700">
                Show all
              </button>
            )}
          </div>
          <div className="py-1 max-h-64 overflow-y-auto">
            {toggleable.map(col => {
              const isVisible = !hidden.has(col.key)
              return (
                <label key={col.key}
                  className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors select-none"
                  onClick={() => onToggle(col.key)}>
                  <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border-2 transition-all
                    ${isVisible ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300 bg-white'}`}>
                    {isVisible && (
                      <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M2 6l3 3 5-5" />
                      </svg>
                    )}
                  </div>
                  <span className="text-xs text-gray-700 flex-1">{getColumnTitle(col)}</span>
                  {isVisible
                    ? <Eye size={11} className="text-gray-300" />
                    : <EyeOff size={11} className="text-gray-300" />}
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main DataTable ───────────────────────────────────────────────────────────

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  loading          = false,
  emptyMessage     = 'No records found',
  emptyIcon,
  keyField         = 'id',
  onRowClick,
  expandedRowKey,
  renderExpandedRow,
  rowClassName,
  compact          = false,
  maxHeight        = '560px',
  showSearch       = true,
  searchable,
  showExport       = true,
  showColumnToggle = true,
  exportFilename   = 'export',
  exportSummaryLines,
  footer,
  title,
  subtitle,
  toolbar,
  toolbarVariant   = 'default',
  striped          = true,
  selectable       = false,
  onSelectionChange,
  initialPageSize  = 25,
  pageSizeOptions  = PAGE_SIZE_OPTIONS,
  showPaginationWhenSinglePage = false,
  onSearchChange,
  searchInputClassName = '',
  searchValue,
  searchPlaceholder = 'Search records…',
}: DataTableProps<T>) {
  const headerPadding = compact ? '0.625rem 0.5rem' : '0.75rem 1rem'
  const cellPadding = compact ? '0.5rem 0.5rem' : '0.75rem 1rem'

  const [sortKey,     setSortKey]     = useState<string | null>(null)
  const [sortDir,     setSortDir]     = useState<SortDir>(null)
  const [internalSearch, setInternalSearch] = useState('')
  const setSearch = React.useCallback((v: string) => {
    setInternalSearch(v)
    onSearchChange?.(v)
  }, [onSearchChange])
  const [page,        setPage]        = useState(1)
  const [pageSize,    setPageSize]    = useState<number | 'All'>(initialPageSize)
  // A pinned column (e.g. a Views 'id'-keyed Action/menu column with a custom
  // render) is always meant to stay visible — isIdColumn's key-pattern guess
  // must not auto-hide it, since a pinned column is also excluded from the
  // manual "Columns" toggle and could otherwise never be shown again.
  const [hiddenCols,  setHiddenCols]  = useState<Set<string>>(
    new Set(columns.filter(c => c.hidden || (isIdColumn(c.key) && !c.pinned)).map(c => c.key))
  )
  const [selected,    setSelected]    = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  // Tier 2 keyboard nav: Up/Down move this, Enter opens, Space selects, Esc clears, "/" focuses search.
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const tableInstanceId = useId()
  const effectiveShowSearch = searchable ?? showSearch
  const compactToolbar = toolbarVariant === 'compact'

  const visibleColumns = useMemo(
    () => columns
      .filter(c => !hiddenCols.has(c.key))
      .map((col) => (
        col.render
          ? col
          : {
              ...col,
              render: (value: unknown) => <span className="truncate block">{formatCell(value, col.key) || '-'}</span>,
            }
      )),
    [columns, hiddenCols]
  )

  const toggleCol = useCallback((key: string) =>
    setHiddenCols(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    }), [])

  // ── Sort ──────────────────────────────────────────────────────────────────
  const handleSort = (key: string) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortDir(null); setSortKey(null) }
    } else {
      setSortKey(key); setSortDir('asc')
    }
  }

  // ── Search + Sort ─────────────────────────────────────────────────────────
  const processed = useMemo(() => {
    let rows = data
    // Skip internal search if parent handles it via onSearchChange (data is pre-filtered)
    if (!onSearchChange && internalSearch.trim()) {
      const q = internalSearch.toLowerCase()
      const searchableCols = columns.filter(c => c.searchable !== false)
      rows = rows.filter(row =>
        searchableCols.some(col => {
          const keys = col.searchKeys ? [col.key, ...col.searchKeys] : [col.key]
          return keys.some(k => {
            const v = (row as any)[k]
            return v != null && String(v).toLowerCase().includes(q)
          })
        })
      )
    }
    if (sortKey && sortDir) {
      rows = [...rows].sort((a, b) => {
        const aVal = a[sortKey], bVal = b[sortKey]
        if (aVal == null) return 1
        if (bVal == null) return -1
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return rows
  }, [data, internalSearch, onSearchChange, sortKey, sortDir, columns])

  // ── Pagination ────────────────────────────────────────────────────────────
  const totalRows   = processed.length
  const effectivePS = pageSize === 'All' ? totalRows : pageSize
  const totalPages  = Math.max(1, Math.ceil(totalRows / (effectivePS || 1)))

  useEffect(() => { setPage(1) }, [internalSearch, pageSize])
  useEffect(() => { setPageSize(initialPageSize); setPage(1) }, [initialPageSize])
  useEffect(() => { setPage(p => Math.min(Math.max(1, p), totalPages)) }, [totalPages])

  const paginated = useMemo(() => {
    if (pageSize === 'All') return processed
    const start = (page - 1) * effectivePS
    return processed.slice(start, start + effectivePS)
  }, [processed, page, pageSize, effectivePS])

  // ── Selection ─────────────────────────────────────────────────────────────
  const allPageKeys   = paginated.map(r => String((r as Record<string, unknown>)[keyField] ?? ''))
  const allSelected   = allPageKeys.length > 0 && allPageKeys.every(k => selected.has(k))
  const someSelected  = allPageKeys.some(k => selected.has(k))

  const toggleAll = () => {
    const next = new Set(selected)
    if (allSelected) allPageKeys.forEach(k => next.delete(k))
    else allPageKeys.forEach(k => next.add(k))
    setSelected(next)
    onSelectionChange?.(data.filter(r => next.has(String((r as Record<string, unknown>)[keyField] ?? ''))))
  }
  const toggleRow = (key: string) => {
    const next = new Set(selected)
    next.has(key) ? next.delete(key) : next.add(key)
    setSelected(next)
    onSelectionChange?.(data.filter(r => next.has(String((r as Record<string, unknown>)[keyField] ?? ''))))
  }

  // Tier 2 keyboard nav for lists/tables: Up/Down move the focused row, Enter opens it
  // (via onRowClick — same callback a click already uses), Space toggles its selection
  // checkbox, Esc clears the current selection, "/" focuses the search box.
  useEffect(() => { setFocusedIndex(-1) }, [page, internalSearch])
  const handleTableKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!paginated.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedIndex(i => {
        const next = e.key === 'ArrowDown' ? Math.min(i + 1, paginated.length - 1) : Math.max(i - 1, 0)
        document.getElementById(`${tableInstanceId}-row-${next}`)?.scrollIntoView({ block: 'nearest' })
        return next
      })
      return
    }
    if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < paginated.length) {
      const row = paginated[focusedIndex]
      const rowKey = String((row as Record<string, unknown>)[keyField] ?? focusedIndex)
      if (selectable) toggleRow(rowKey)
      onRowClick?.(row)
      return
    }
    if (e.key === ' ' && selectable && focusedIndex >= 0 && focusedIndex < paginated.length) {
      e.preventDefault()
      const row = paginated[focusedIndex]
      toggleRow(String((row as Record<string, unknown>)[keyField] ?? focusedIndex))
      return
    }
    if (e.key === 'Escape' && selected.size > 0) {
      setSelected(new Set())
      onSelectionChange?.([])
      return
    }
    if (e.key === '/' && document.activeElement !== searchRef.current) {
      e.preventDefault()
      searchRef.current?.focus()
    }
  }

  // ── Page numbers ──────────────────────────────────────────────────────────
  const pageNumbers = useMemo(() => {
    const range: (number | '...')[] = []
    const delta = 2
    const left  = Math.max(2, page - delta)
    const right = Math.min(totalPages - 1, page + delta)
    range.push(1)
    if (left > 2)               range.push('...')
    for (let i = left; i <= right; i++) range.push(i)
    if (right < totalPages - 1) range.push('...')
    if (totalPages > 1)         range.push(totalPages)
    return range
  }, [page, totalPages])

  const startRow = totalRows === 0 ? 0 : (page - 1) * effectivePS + 1
  const endRow   = Math.min(page * effectivePS, totalRows)
  const showPageNavigator = pageSize !== 'All' && totalRows > 0 && (totalPages > 1 || showPaginationWhenSinglePage)

  const SortIcon = ({ colKey }: { colKey: string }) => {
    if (sortKey !== colKey) return <ChevronsUpDown size={11} className="opacity-30 group-hover:opacity-60 transition-opacity ml-1" />
    if (sortDir === 'asc')  return <ChevronUp  size={11} className="text-blue-500 ml-1" />
    return                         <ChevronDown size={11} className="text-blue-500 ml-1" />
  }

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col rounded-2xl border border-gray-200/80 bg-white shadow-sm overflow-hidden">

      {/* ── Top toolbar ─────────────────────────────────────────────── */}
      {(title || effectiveShowSearch || showExport || showColumnToggle || toolbar) && (() => {
        const searchInput = effectiveShowSearch && (
          <div className="relative flex-shrink-0">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              ref={searchRef}
              value={internalSearch}
              onChange={e => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className={`pl-8 pr-8 py-2 text-xs border border-gray-200 rounded-lg bg-white
                focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400
                placeholder:text-gray-400 transition-all ${searchInputClassName || (compactToolbar?'w-[210px]':'w-52')}`}
            />
            {internalSearch && (
              <button onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors">
                <X size={12} />
              </button>
            )}
          </div>
        )

        return (
        <div className={compactToolbar
          ? 'flex items-center gap-2 border-b border-gray-100 bg-white px-3 py-3'
          : 'flex flex-col gap-3 border-b border-gray-100 bg-gradient-to-r from-gray-50/80 to-white px-5 py-3.5 sm:flex-row sm:items-center'}>
          {(title || subtitle) && (
            <div className="flex-shrink-0 mr-2">
              {title    && <p className="text-sm font-semibold text-gray-800">{title}</p>}
              {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
            </div>
          )}

          {/* Search + filters — wrap together as one sequence instead of overlapping or clipping */}
          {compactToolbar ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {searchInput}
              {toolbar}
            </div>
          ) : (
            <>
              {searchInput}
              {toolbar}
            </>
          )}

          <div className={`flex flex-shrink-0 flex-wrap items-center gap-2 ${compactToolbar?'ml-auto':'sm:ml-auto'}`}>
            {showColumnToggle && (
              <ColumnToggle columns={columns} hidden={hiddenCols} onToggle={toggleCol} />
            )}

            {showExport && (
              <ExportMenu
                processed={processed}
                visibleColumns={visibleColumns}
                exportFilename={exportFilename}
                summaryLines={exportSummaryLines}
              />
            )}
          </div>
        </div>
        )
      })()}

      {/* Selection bar */}
      {selectable && selected.size > 0 && (
        <div className="flex items-center gap-3 px-5 py-2.5 bg-blue-50 border-b border-blue-100">
          <div className="w-4 h-4 rounded bg-blue-600 flex items-center justify-center flex-shrink-0">
            <Check size={10} className="text-white" />
          </div>
          <span className="text-xs font-semibold text-blue-700">
            {selected.size} row{selected.size !== 1 ? 's' : ''} selected
          </span>
          <button onClick={() => { setSelected(new Set()); onSelectionChange?.([]) }}
            className="ml-auto text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1">
            <X size={11} /> Clear
          </button>
        </div>
      )}

      {/* ── Table ───────────────────────────────────────────────────── */}
      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight }} className="flex-1" tabIndex={0} onKeyDown={handleTableKeyDown}>
        <table className="w-full text-sm border-collapse" style={{ minWidth: '100%', tableLayout: 'auto' }}>
          <colgroup>
            {selectable && <col style={{ width: '2.5rem' }} />}
            {visibleColumns.map(col => (
              <col key={col.key} style={{ width: col.width, minWidth: col.minWidth }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              {selectable && (
                <th className="bg-gray-50 border-b border-gray-200 w-10" style={{ padding: headerPadding }}>
                  <div
                    onClick={toggleAll}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center cursor-pointer transition-all
                      ${allSelected ? 'bg-blue-600 border-blue-600' : someSelected ? 'bg-blue-100 border-blue-400' : 'border-gray-300 hover:border-blue-400'}`}
                  >
                    {allSelected && <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2 6l3 3 5-5" /></svg>}
                    {someSelected && !allSelected && <div className="w-2 h-0.5 bg-blue-500 rounded" />}
                  </div>
                </th>
              )}
              {visibleColumns.map(col => (
                <th
                  key={col.key}
                  style={{
                    width: col.width,
                    minWidth: col.minWidth,
                    textAlign: col.align || 'left',
                    padding: headerPadding,
                  }}
                  className={`text-[11px] font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap select-none
                    bg-gray-50 border-b border-gray-200
                    ${col.sortable ? 'cursor-pointer group hover:bg-gray-100 hover:text-gray-700 transition-colors' : ''}`}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  <div className={`flex items-center ${col.align === 'center' ? 'justify-center' : col.align === 'right' ? 'justify-end' : ''}`}>
                    {getColumnTitle(col)}
                    {col.sortable && <SortIcon colKey={col.key} />}
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-gray-100">
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="animate-pulse">
                  {selectable && <td className="px-4 py-3"><div className="w-4 h-4 rounded bg-gray-100" /></td>}
                  {visibleColumns.map(col => (
                    <td key={col.key} className="px-4 py-3">
                      <div className="h-3 rounded-full bg-gray-100"
                        style={{ width: `${40 + (i * 11 + col.key.length * 9) % 45}%` }} />
                      {i % 3 === 0 && col.key === visibleColumns[0]?.key && (
                        <div className="h-2.5 rounded-full bg-gray-100 mt-1.5" style={{ width: '55%' }} />
                      )}
                    </td>
                  ))}
                </tr>
              ))
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length + (selectable ? 1 : 0)} className="px-4 py-20 text-center">
                  <div className="flex flex-col items-center gap-3">
                    {emptyIcon
                      ? <div className="opacity-20 scale-150">{emptyIcon}</div>
                      : <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center">
                          <Search size={24} className="text-gray-300" />
                        </div>}
                    <div>
                      <p className="text-sm font-semibold text-gray-500">{emptyMessage}</p>
                      {internalSearch && (
                        <p className="text-xs text-gray-400 mt-1.5">
                          No results for "<span className="font-medium text-gray-600">{internalSearch}</span>"
                          {' · '}
                          <button onClick={() => setSearch('')} className="text-blue-500 hover:underline font-medium">
                            Clear search
                          </button>
                        </p>
                      )}
                    </div>
                  </div>
                </td>
              </tr>
            ) : (
              paginated.map((row, idx) => {
                const rowKey = String((row as Record<string, unknown>)[keyField] ?? idx)
                const isSelected = selected.has(rowKey)
                const isExpanded = Boolean(renderExpandedRow && expandedRowKey === rowKey)
                return (
                  <React.Fragment key={rowKey}>
                  <tr
                    id={`${tableInstanceId}-row-${idx}`}
                    onClick={() => {
                      setFocusedIndex(idx)
                      if (selectable) toggleRow(rowKey)
                      onRowClick?.(row)
                    }}
                    className={`transition-colors group
                      ${onRowClick || selectable ? 'cursor-pointer' : ''}
                      ${idx === focusedIndex ? 'ring-2 ring-inset ring-blue-400' : ''}
                      ${isExpanded ? 'bg-blue-50/40' : isSelected
                        ? 'bg-blue-50 hover:bg-blue-50/80'
                        : striped && idx % 2 === 1
                          ? 'bg-gray-50/40 hover:bg-blue-50/30'
                          : 'bg-white hover:bg-blue-50/30'}
                      ${rowClassName?.(row) ?? ''}`}
                  >
                    {selectable && (
                      <td className="px-4" style={{ padding: cellPadding }}>
                        <div
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all
                            ${isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-300 group-hover:border-blue-400'}`}
                          onClick={e => { e.stopPropagation(); toggleRow(rowKey) }}
                        >
                          {isSelected && <svg viewBox="0 0 12 12" className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M2 6l3 3 5-5" /></svg>}
                        </div>
                      </td>
                    )}
                    {visibleColumns.map(col => (
                      <td
                        key={col.key}
                        style={{ width: col.width, minWidth: col.minWidth, textAlign: col.align, padding: cellPadding }}
                        className="text-sm text-gray-700 overflow-hidden max-w-0"
                      >
                        {col.render
                          ? col.render((row as Record<string, unknown>)[col.key], row)
                          : <span className="truncate block">{String((row as Record<string, unknown>)[col.key] ?? '—')}</span>}
                      </td>
                    ))}
                  </tr>
                  {isExpanded && (
                    <tr className="bg-white">
                      <td colSpan={visibleColumns.length + (selectable ? 1 : 0)} className="p-0">
                        {renderExpandedRow?.(row)}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                )
              })
            )}
          </tbody>

          {footer && (
            <tfoot className="sticky bottom-0">
              <tr className="bg-gray-50 border-t-2 border-gray-200 font-semibold">{footer}</tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ── Bottom bar ──────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-3 border-t border-gray-100 bg-gray-50/40">

        {/* Info + Page size */}
        <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
          <span className="font-medium">
            {totalRows === 0
              ? 'No records'
              : pageSize === 'All'
                ? `All ${totalRows} record${totalRows !== 1 ? 's' : ''}`
                : `${startRow}–${endRow} of ${totalRows} record${totalRows !== 1 ? 's' : ''}`}
            {internalSearch && data.length !== totalRows && (
              <span className="text-gray-400 font-normal ml-1">(filtered from {data.length})</span>
            )}
          </span>

          <div className="h-3 w-px bg-gray-300 hidden sm:block" />

          <div className="flex items-center gap-1.5">
            <span className="text-gray-400">Rows per page:</span>
            <div className="flex rounded-lg overflow-hidden border border-gray-200 divide-x divide-gray-200">
              {pageSizeOptions.map(opt => (
                <button
                  key={String(opt)}
                  onClick={() => setPageSize(opt)}
                  className={`px-2.5 py-1 text-[11px] font-medium transition-colors
                    ${pageSize === opt
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-500 hover:bg-gray-100 hover:text-gray-700'}`}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Pagination */}
        {showPageNavigator && (
          <div className="flex items-center gap-1 sm:ml-auto">
            <button onClick={() => setPage(1)} disabled={page === 1}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="First page">
              <ChevronsLeft size={14} />
            </button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Previous page">
              <ChevronLeft size={14} />
            </button>

            {pageNumbers.map((p, i) =>
              p === '...' ? (
                <span key={`dots-${i}`} className="w-8 h-8 flex items-center justify-center text-xs text-gray-400">
                  <MoreHorizontal size={14} />
                </span>
              ) : (
                <button
                  key={p}
                  onClick={() => setPage(p as number)}
                  className={`w-8 h-8 flex items-center justify-center rounded-lg text-xs font-semibold transition-all
                    ${page === p
                      ? 'bg-blue-600 text-white shadow-sm shadow-blue-200 scale-105'
                      : 'text-gray-600 hover:bg-gray-100'}`}
                >
                  {p}
                </button>
              )
            )}

            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Next page">
              <ChevronRight size={14} />
            </button>
            <button onClick={() => setPage(totalPages)} disabled={page === totalPages}
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Last page">
              <ChevronsRight size={14} />
            </button>

            {/* Jump to page */}
            <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-gray-200">
              <span className="text-xs text-gray-400">Go to</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                defaultValue={page}
                key={page}
                onBlur={e => {
                  const v = parseInt(e.target.value)
                  if (v >= 1 && v <= totalPages) setPage(v)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const v = parseInt((e.target as HTMLInputElement).value)
                    if (v >= 1 && v <= totalPages) setPage(v)
                  }
                }}
                className="w-12 px-2 py-1 text-xs border border-gray-200 rounded-lg text-center focus:outline-none focus:border-blue-400"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Badge helpers ─────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    // General
    Active:       'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    Converted:    'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    Won:          'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    Completed:    'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    Approved:     'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    approved:     'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    Lost:         'bg-red-50 text-red-700 ring-1 ring-red-200',
    Cancelled:    'bg-red-50 text-red-700 ring-1 ring-red-200',
    Rejected:     'bg-red-50 text-red-700 ring-1 ring-red-200',
    rejected:     'bg-red-50 text-red-700 ring-1 ring-red-200',
    Suspended:    'bg-red-50 text-red-700 ring-1 ring-red-200',
    Pending:      'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
    pending:      'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
    'In Progress':'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
    Trial:        'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
    Prospect:     'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
    Inactive:     'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
    Churned:      'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
    // Priority
    High:   'bg-red-50 text-red-600 ring-1 ring-red-200',
    Medium: 'bg-amber-50 text-amber-600 ring-1 ring-amber-200',
    Low:    'bg-gray-100 text-gray-500 ring-1 ring-gray-200',
    // Lead statuses
    New:                       'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
    Assigned:                  'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200',
    'Qualified':'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
    'Opportunity Created':     'bg-purple-50 text-purple-700 ring-1 ring-purple-200',
    none: 'bg-gray-50 text-gray-400 ring-1 ring-gray-200',
  }
  if (!status) return null
  const cls = map[status] || 'bg-gray-100 text-gray-600 ring-1 ring-gray-200'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${cls}`}>
      {status}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: string }) {
  return <StatusBadge status={priority} />  
}

// Named export alias so both `import DataTable` and `import { DataTable }` work
export default DataTable
