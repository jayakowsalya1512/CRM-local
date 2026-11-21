/**
 * UserQuestionnaireExportDialog.tsx — Export popup for the role-wise
 * Questionnaire report's per-user "Customer Summary" table (RoleScreen ->
 * UserScreen in QuestionnaireInsightModal.tsx). Mirrors
 * QuestionnaireExportDialog.tsx's Scope x Format x File Structure options,
 * but instead of pulling each customer's full Q&A form it builds two flat
 * tables from data already available to the report engine: a "Customer
 * Summary" sheet (the rows visible in the on-screen table) and a "Detail
 * Report" sheet (one row per question/field answer, fetched on demand from
 * the questionnaire_user_detail report type since it isn't paged in until
 * export time).
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Loader2, X } from 'lucide-react'
import ExcelJS from 'exceljs'
import { saveAs } from 'file-saver'

import { reportEngineApi, type FilterItem } from '@/services/reportEngineApi'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { isYesNoAnswerType } from '@/pages/questionnaire/questionnaireFormShared'
import {
  buildPdfBlob,
  buildSectionedPdfBlob,
  printSections,
  downloadBlob,
  zipAndDownload,
  safeFileName,
  type ExportColumn,
  type ExportSection,
} from '@/utils/reportExport'

type Scope = 'all' | 'selected'
type Format = 'excel' | 'pdf' | 'print'
type Structure = 'single' | 'separate'

const STATUS_LABEL: Record<string, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  completed: 'Completed',
  reopened: 'Reopened',
}

const SUMMARY_COLUMNS: ExportColumn[] = [
  { key: 'customer_name', header: 'Customer' },
  { key: 'questionnaire_name', header: 'Questionnaire' },
  { key: 'category', header: 'Category' },
  { key: 'status', header: 'Status' },
  { key: 'questions', header: 'Total Questions' },
  { key: 'answered', header: 'Answered' },
  { key: 'pending', header: 'Pending' },
  { key: 'completion_pct', header: 'Completion %' },
  { key: 'last_activity_at', header: 'Last Activity' },
]

const DETAIL_COLUMNS: ExportColumn[] = [
  { key: 'customer_name', header: 'Customer' },
  { key: 'section_name', header: 'Section' },
  { key: 'subsection_name', header: 'Sub Section' },
  { key: 'question_code', header: 'Question Code' },
  { key: 'question_label', header: 'Question' },
  { key: 'yes_no', header: 'Yes/No' },
  { key: 'field', header: 'Field' },
]

function fmtDateCell(v: unknown): string {
  if (!v) return ''
  const d = new Date(String(v))
  return Number.isNaN(d.getTime())
    ? String(v)
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function summaryCellValue(row: Record<string, unknown>, key: string): string {
  if (key === 'status') return STATUS_LABEL[String(row.status ?? '')] || String(row.status ?? '—')
  if (key === 'completion_pct') return row.completion_pct == null ? '—' : `${row.completion_pct}%`
  if (key === 'last_activity_at') return fmtDateCell(row.last_activity_at) || '—'
  if (key === 'category') return String(row.category || '—')
  const v = row[key]
  return v == null ? '—' : String(v)
}

function detailRowToYesNo(row: Record<string, unknown>): string {
  if (String(row.element_type ?? 'question') !== 'question') return ''
  if (!isYesNoAnswerType(String(row.input_type ?? ''))) return ''
  const v = String(row.answer_value ?? '').trim().toLowerCase()
  if (v === 'yes') return 'Yes'
  if (v === 'no') return 'No'
  return ''
}

function detailRowToField(row: Record<string, unknown>): string {
  if (String(row.element_type ?? 'question') !== 'field') return ''
  const label = String(row.field_label ?? '')
  const value = String(row.answer_value ?? '').trim() || '-'
  return label ? `${label}: ${value}` : value
}

function detailCellValue(row: Record<string, unknown>, key: string): string {
  if (key === 'yes_no') return detailRowToYesNo(row)
  if (key === 'field') return detailRowToField(row)
  if (key === 'section_name' || key === 'subsection_name') return String(row[key] || '—')
  const v = row[key]
  return v == null ? '' : String(v)
}

function rowsToCells(rows: Record<string, unknown>[], columns: ExportColumn[], cellFn: (row: Record<string, unknown>, key: string) => string): string[][] {
  return rows.map(row => columns.map(c => cellFn(row, c.key)))
}

function todayStamp(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${d.getFullYear()}`
}

async function fetchAllDetailRows(filters: FilterItem[]): Promise<Record<string, unknown>[]> {
  const fields = [
    'id', 'customer_id', 'customer_name', 'section_name', 'subsection_name',
    'question_code', 'question_label', 'field_label', 'element_type',
    'input_type', 'answer_value',
  ]
  const perPage = 500
  let page = 1
  let all: Record<string, unknown>[] = []

  while (true) {
    const res = await reportEngineApi.runAdhoc({
      report_type_key: 'questionnaire_user_detail',
      fields,
      filters,
      page,
      per_page: perPage,
    })
    const rows = res.data.rows ?? []
    all = all.concat(rows)
    if (rows.length < perPage || all.length >= (res.data.total ?? all.length)) break
    page++
  }

  return all
}

async function buildTwoSheetWorkbook(
  summaryRows: Record<string, unknown>[],
  detailRows: Record<string, unknown>[],
): Promise<Blob> {
  const workbook = new ExcelJS.Workbook()

  const summarySheet = workbook.addWorksheet('Customer Summary')
  summarySheet.columns = SUMMARY_COLUMNS.map(c => ({ header: c.header, key: c.key, width: 20 }))
  summaryRows.forEach(row => {
    summarySheet.addRow(
      Object.fromEntries(SUMMARY_COLUMNS.map(c => [c.key, summaryCellValue(row, c.key)])),
    )
  })
  summarySheet.getRow(1).font = { bold: true }
  summarySheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  })
  summarySheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + SUMMARY_COLUMNS.length)}1` }

  const detailSheet = workbook.addWorksheet('Detail Report')
  detailSheet.columns = DETAIL_COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.key === 'question_label' || c.key === 'field' ? 40 : 20 }))
  detailRows.forEach(row => {
    detailSheet.addRow(
      Object.fromEntries(DETAIL_COLUMNS.map(c => [c.key, detailCellValue(row, c.key)])),
    )
  })
  detailSheet.getRow(1).font = { bold: true }
  detailSheet.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  })
  detailSheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + DETAIL_COLUMNS.length)}1` }

  const buffer = await workbook.xlsx.writeBuffer()
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

export function UserQuestionnaireExportDialog({
  open,
  onClose,
  summaryRows,
  selectedCustomerIds,
  userFilter,
  reportName,
}: {
  open: boolean
  onClose: () => void
  summaryRows: Record<string, unknown>[]
  selectedCustomerIds: Set<number>
  userFilter: FilterItem
  reportName: string
}) {
  const [scope, setScope] = useState<Scope>('all')
  const [format, setFormat] = useState<Format>('excel')
  const [structure, setStructure] = useState<Structure>('single')
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { label: customerLabel } = useModuleName('customers')

  useEffect(() => {
    if (open) {
      setScope(selectedCustomerIds.size > 0 ? 'selected' : 'all')
      setFormat('excel')
      setStructure('single')
      setBusy(false)
      setStatusText(null)
      setError(null)
    }
  }, [open, selectedCustomerIds.size])

  if (!open) return null

  const targetSummaryRows = scope === 'selected'
    ? summaryRows.filter(r => selectedCustomerIds.has(Number(r.customer_id)))
    : summaryRows

  const structureLocked = format === 'print'
  const effectiveStructure: Structure = structureLocked ? 'single' : structure

  async function runExport() {
    setBusy(true)
    setError(null)
    setStatusText('Fetching detail report data…')

    try {
      const allDetailRows = await fetchAllDetailRows([userFilter])
      const targetCustomerIds = new Set(targetSummaryRows.map(r => Number(r.customer_id)))
      const targetDetailRows = allDetailRows.filter(r => targetCustomerIds.has(Number(r.customer_id)))

      setStatusText('Building export…')

      if (effectiveStructure === 'single') {
        if (format === 'excel') {
          const blob = await buildTwoSheetWorkbook(targetSummaryRows, targetDetailRows)
          saveAs(blob, `${safeFileName(reportName)}_${todayStamp()}.xlsx`)
        } else {
          const sections: ExportSection[] = [
            { heading: 'Customer Summary', columns: SUMMARY_COLUMNS, rows: rowsToCells(targetSummaryRows, SUMMARY_COLUMNS, summaryCellValue) },
            { heading: 'Detail Report', columns: DETAIL_COLUMNS, rows: rowsToCells(targetDetailRows, DETAIL_COLUMNS, detailCellValue) },
          ]

          if (format === 'pdf') {
            downloadBlob(buildSectionedPdfBlob(sections, reportName), `${safeFileName(reportName)}_${todayStamp()}.pdf`)
          } else {
            printSections(sections, reportName)
          }
        }
      } else {
        const detailByCustomer = new Map<number, Record<string, unknown>[]>()
        targetDetailRows.forEach(row => {
          const id = Number(row.customer_id)
          const list = detailByCustomer.get(id) || []
          list.push(row)
          detailByCustomer.set(id, list)
        })

        const files: { name: string; blob: Blob }[] = []

        for (const row of targetSummaryRows) {
          const customerId = Number(row.customer_id)
          const customerName = String(row.customer_name ?? `Customer ${customerId}`)
          const customerDetailRows = detailByCustomer.get(customerId) || []

          if (format === 'excel') {
            const blob = await buildTwoSheetWorkbook([row], customerDetailRows)
            files.push({ name: `${safeFileName(customerName)}.xlsx`, blob })
          } else {
            const sections: ExportSection[] = [
              { heading: 'Customer Summary', columns: SUMMARY_COLUMNS, rows: rowsToCells([row], SUMMARY_COLUMNS, summaryCellValue) },
              { heading: 'Detail Report', columns: DETAIL_COLUMNS, rows: rowsToCells(customerDetailRows, DETAIL_COLUMNS, detailCellValue) },
            ]
            files.push({ name: `${safeFileName(customerName)}.pdf`, blob: buildPdfSections(sections, customerName) })
          }
        }

        if (files.length) {
          await zipAndDownload(files, `${safeFileName(reportName)}_Export_${todayStamp()}.zip`)
        }
      }

      onClose()
    } catch {
      setError('Export failed — please try again')
    } finally {
      setBusy(false)
      setStatusText(null)
    }
  }

  function buildPdfSections(sections: ExportSection[], title: string): Blob {
    return buildSectionedPdfBlob(sections, title)
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">

        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <h2 className="text-[15px] font-bold text-slate-900">Export</h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
          >
            <X size={15} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">

          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Scope</div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
                All {customerLabel} ({summaryRows.length})
              </label>
              <label className={`flex items-center gap-2 text-sm ${selectedCustomerIds.size ? 'text-slate-700' : 'text-slate-300'}`}>
                <input
                  type="radio"
                  checked={scope === 'selected'}
                  disabled={!selectedCustomerIds.size}
                  onChange={() => setScope('selected')}
                />
                Selected {customerLabel} ({selectedCustomerIds.size})
              </label>
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Format</div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" checked={format === 'excel'} onChange={() => setFormat('excel')} />
                Excel
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" checked={format === 'pdf'} onChange={() => setFormat('pdf')} />
                PDF
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" checked={format === 'print'} onChange={() => setFormat('print')} />
                Print
              </label>
            </div>
          </div>

          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">File Structure</div>
            <div className="space-y-1.5">
              <label className={`flex items-center gap-2 text-sm ${structureLocked ? 'text-slate-300' : 'text-slate-700'}`}>
                <input type="radio" checked={effectiveStructure === 'single'} disabled={structureLocked} onChange={() => setStructure('single')} />
                Single file (Customer Summary + Detail Report sheets)
              </label>
              <label className={`flex items-center gap-2 text-sm ${structureLocked ? 'text-slate-300' : 'text-slate-700'}`}>
                <input type="radio" checked={effectiveStructure === 'separate'} disabled={structureLocked} onChange={() => setStructure('separate')} />
                Separate file for each customer (ZIP)
              </label>
            </div>
          </div>

          {statusText && (
            <div className="text-[12px] text-slate-500">{statusText}</div>
          )}

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[12px] text-rose-600">{error}</div>
          )}

        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-9 rounded-lg border border-slate-200 px-3.5 text-[13px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={runExport}
            disabled={busy || !targetSummaryRows.length}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-[13px] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {format === 'print' ? 'Print' : 'Export'}
          </button>
        </div>

      </div>
    </div>,
    document.body,
  )
}
