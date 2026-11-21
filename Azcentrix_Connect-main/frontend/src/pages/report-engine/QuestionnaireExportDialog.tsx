/**
 * QuestionnaireExportDialog.tsx — the Questionnaire report's Export popup.
 * Scope (all / selected customers) × Format (Excel / PDF / Print) × File
 * structure (single consolidated file — one customer per page, or one file
 * per customer bundled into a ZIP). "Separate file per customer" is
 * deliberately buried here as an advanced option rather than a second
 * top-level export button — most exports want one file, and burying the rare
 * case keeps the common case a single click.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Loader2, X } from 'lucide-react'
import { saveAs } from 'file-saver'

import { questionnaireApi } from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  buildExcelBlob,
  buildPdfBlob,
  buildSectionedPdfBlob,
  printSections,
  downloadBlob,
  zipAndDownload,
  safeFileName,
  type ExportColumn,
  type ExportSection,
} from '@/utils/reportExport'
import {
  buildQuestionTableRows,
  compareQuestionCodes,
  type CustomerQAResponse,
} from './QuestionnaireInsightModal'

type Scope = 'all' | 'selected'
type Format = 'excel' | 'pdf' | 'print'
type Structure = 'single' | 'separate'

const PER_CUSTOMER_COLUMNS: ExportColumn[] = [
  { key: 'question_code', header: 'Question Code' },
  { key: 'section_name', header: 'Section' },
  { key: 'subsection_name', header: 'Sub Section' },
  { key: 'question_label', header: 'Question' },
  { key: 'yes_no', header: 'Yes/No' },
  { key: 'field_details', header: 'Field Details' },
]

function formatCellValue(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function todayStamp(): string {
  const d = new Date()
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}-${mm}-${d.getFullYear()}`
}

type PerCustomer = { customerName: string; tableRows: ReturnType<typeof buildQuestionTableRows> }
type QuestionnaireTableRow = PerCustomer['tableRows'][number]

const PIVOT_COLORS = {
  navy: 'FF1E3A5F',
  midBlue: 'FF4A7EBB',
  lightBlue: 'FFD9E8F5',
  lightGreen: 'FFE8F5E9',
  gray: 'FFE5E7EB',
  greenFont: 'FF16A34A',
  linkBlue: 'FF2563EB',
}

// Excel sheet names: 31 chars max, no : \ / ? * [ ]
function sectionSheetName(letter: string): string {
  return `Section ${letter}`.slice(0, 31)
}

function sectionLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `A${index - 25}`
}

function groupRowsByQuestionCode(tableRows: PerCustomer['tableRows']): Map<string, QuestionnaireTableRow> {
  const grouped = new Map<string, QuestionnaireTableRow>()

  tableRows.forEach(row => {
    const existing = grouped.get(row.question_code)

    if (!existing) {
      grouped.set(row.question_code, {
        ...row,
        field_details_pairs: [...row.field_details_pairs],
      })
      return
    }

    const seen = new Set(existing.field_details_pairs.map(pair => `${pair.id}:${pair.label}`))

    row.field_details_pairs.forEach(pair => {
      const key = `${pair.id}:${pair.label}`
      if (seen.has(key)) return

      existing.field_details_pairs.push(pair)
      seen.add(key)
    })

    existing.field_details = existing.field_details_pairs
      .map(pair => `${pair.label}: ${pair.value}`)
      .join('\n')
  })

  return grouped
}

// Real multi-sheet workbook for the "Single file" + Excel combination only —
// PDF, Print, and the "Separate file per customer" ZIP path are untouched and
// keep using the existing HTML-table-based builders in reportExport.ts.
// Sheet 1 ("Overview") is a cover/index page with one row per Section and a
// hyperlink into that section's own worksheet. One worksheet per Section
// follows, with customers as rows and every question (plus its dynamic
// fields) as columns, so multiple customers can be compared side by side
// within a section. The final sheet ("Detailed Data") is the flat,
// filterable row-per-answer-field export.
async function buildQuestionnaireWorkbook(
  perCustomer: PerCustomer[],
  reportName: string,
): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()

  interface QuestionColumnDef {
    questionCode: string
    sectionName: string
    questionLabel: string
    fieldLabels: string[]
  }

  const questionColumns = new Map<string, QuestionColumnDef>()

  perCustomer.forEach(({ tableRows }) => {
    tableRows.forEach(row => {
      let def = questionColumns.get(row.question_code)

      if (!def) {
        def = {
          questionCode: row.question_code,
          sectionName: row.section_name || '—',
          questionLabel: row.question_label,
          fieldLabels: [],
        }
        questionColumns.set(row.question_code, def)
      }

      // Unioned across customers so a "No" answer that hides a field for one
      // customer doesn't drop that field's column for everyone else.
      row.field_details_pairs.forEach(pair => {
        if (!def!.fieldLabels.includes(pair.label)) def!.fieldLabels.push(pair.label)
      })
    })
  })

  const orderedQuestions = Array.from(questionColumns.values())
    .sort((a, b) => compareQuestionCodes(a.questionCode, b.questionCode))

  // Question codes are already globally sorted, so each section's questions
  // land contiguously — a single pass groups them without re-sorting.
  const sectionGroups: { sectionName: string; questions: QuestionColumnDef[] }[] = []

  orderedQuestions.forEach(def => {
    const last = sectionGroups[sectionGroups.length - 1]

    if (last && last.sectionName === def.sectionName) {
      last.questions.push(def)
    } else {
      sectionGroups.push({ sectionName: def.sectionName, questions: [def] })
    }
  })

  // ── Sheet 1: Detailed Data (flat, filterable row-per-answer-field export) ─
  const detailSheet = workbook.addWorksheet('Detailed Data')

  detailSheet.columns = [
    { header: 'Customer Name', key: 'customer', width: 22 },
    { header: 'Section', key: 'section', width: 32 },
    { header: 'Sub Section', key: 'subsection', width: 32 },
    { header: 'Question Code', key: 'code', width: 14 },
    { header: 'Question', key: 'question', width: 48 },
    { header: 'Answer', key: 'answer', width: 12 },
    { header: 'Field Name', key: 'fieldName', width: 26 },
    { header: 'Field Value', key: 'fieldValue', width: 32 },
  ]

  perCustomer.forEach(({ customerName, tableRows }) => {
    tableRows.forEach(row => {
      const answer = row.yes_no || 'Not Answered'
      const base = {
        customer: customerName,
        section: row.section_name,
        subsection: row.subsection_name,
        code: row.question_code,
        question: row.question_label,
        answer,
      }

      if (row.field_details_pairs.length) {
        row.field_details_pairs.forEach(pair => {
          detailSheet.addRow({ ...base, fieldName: pair.label, fieldValue: pair.value })
        })
      } else {
        detailSheet.addRow({ ...base, fieldName: '', fieldValue: '' })
      }
    })
  })

  detailSheet.getRow(1).font = { bold: true }
  detailSheet.autoFilter = 'A1:H1'

  // ── Sheet 2: Overview (cover / index, with hyperlinks into each section) ──
  const overviewSheet = workbook.addWorksheet('Overview')

  overviewSheet.mergeCells('A1:D1')
  const titleCell = overviewSheet.getCell('A1')
  titleCell.value = 'Questionnaire Pivot Export'
  titleCell.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.navy } }
  titleCell.alignment = { vertical: 'middle' }
  overviewSheet.getRow(1).height = 30

  const customerLabel = perCustomer.length === 1
    ? perCustomer[0].customerName
    : perCustomer.length <= 5
      ? perCustomer.map(c => c.customerName).join(', ')
      : `${perCustomer.length} customers`

  overviewSheet.getCell('A3').value = 'Customer'
  overviewSheet.getCell('A3').font = { bold: true }
  overviewSheet.getCell('B3').value = customerLabel
  overviewSheet.getCell('B3').font = { bold: true, color: { argb: PIVOT_COLORS.greenFont } }

  overviewSheet.getCell('A4').value = 'Format'
  overviewSheet.getCell('A4').font = { bold: true }
  overviewSheet.getCell('B4').value = 'One worksheet per Section; questions and dynamic fields are columns; customers are rows.'
  overviewSheet.getCell('B4').font = { color: { argb: 'FF6B7280' } }
  overviewSheet.getCell('B4').alignment = { wrapText: true }

  const indexHeaderRow = overviewSheet.getRow(6)
  ;['Section', 'Section Name', 'Questions', 'Open Sheet'].forEach((label, i) => {
    const cell = indexHeaderRow.getCell(i + 1)
    cell.value = label
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.navy } }
  })
  overviewSheet.autoFilter = 'A6:D6'

  overviewSheet.columns = [{ width: 12 }, { width: 44 }, { width: 12 }, { width: 14 }]

  sectionGroups.forEach((group, index) => {
    const letter = sectionLetter(index)
    const sheetName = sectionSheetName(letter)
    const row = overviewSheet.getRow(7 + index)

    row.getCell(1).value = `Section ${letter}`
    row.getCell(2).value = group.sectionName
    row.getCell(3).value = group.questions.length

    const linkCell = row.getCell(4)
    linkCell.value = { text: 'Open', hyperlink: `#'${sheetName}'!A1` }
    linkCell.font = { color: { argb: PIVOT_COLORS.linkBlue }, underline: true, bold: true }
  })

  // ── One worksheet per Section ────────────────────────────────────────────
  sectionGroups.forEach((group, index) => {
    const letter = sectionLetter(index)
    const sheet = workbook.addWorksheet(sectionSheetName(letter))

    const totalCols = 1 + group.questions.reduce((sum, q) => sum + 1 + q.fieldLabels.length, 0)

    // Row 1 — section title banner, full width.
    if (totalCols > 1) sheet.mergeCells(1, 1, 1, totalCols)
    const bannerCell = sheet.getCell(1, 1)
    bannerCell.value = `SECTION ${letter} - ${group.sectionName}`
    bannerCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
    bannerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.navy } }
    bannerCell.alignment = { vertical: 'middle' }
    sheet.getRow(1).height = 26

    // Column A — "Customer" corner header, merged down through the header rows.
    sheet.mergeCells(2, 1, 5, 1)
    const customerHeaderCell = sheet.getCell(2, 1)
    customerHeaderCell.value = 'Customer'
    customerHeaderCell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    customerHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.navy } }
    customerHeaderCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }

    // Row 2 (columns B onward) — light spacer band under the title banner.
    if (totalCols > 1) {
      sheet.mergeCells(2, 2, 2, totalCols)
      sheet.getCell(2, 2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.lightGreen } }
    }

    const columnWidths: number[] = [20]
    const questionEndCols: number[] = []
    let col = 2

    group.questions.forEach(def => {
      const span = 1 + def.fieldLabels.length
      const startCol = col
      const endCol = col + span - 1
      questionEndCols.push(endCol)

      // Row 3 — question code, merged across its Answer + field columns.
      if (endCol > startCol) sheet.mergeCells(3, startCol, 3, endCol)
      const codeCell = sheet.getCell(3, startCol)
      codeCell.value = def.questionCode
      codeCell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      codeCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.midBlue } }
      codeCell.alignment = { horizontal: 'center', vertical: 'middle' }

      // Row 4 — question text, same merge span.
      if (endCol > startCol) sheet.mergeCells(4, startCol, 4, endCol)
      const labelCell = sheet.getCell(4, startCol)
      labelCell.value = def.questionLabel
      labelCell.font = { color: { argb: 'FF1F2937' } }
      labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.lightBlue } }
      labelCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }

      // Row 5 — "Answer" + one cell per dynamic field name.
      const answerCell = sheet.getCell(5, startCol)
      answerCell.value = 'Answer'
      answerCell.font = { bold: true }
      answerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.gray } }
      answerCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
      columnWidths.push(10)

      def.fieldLabels.forEach((label, fi) => {
        const fieldCell = sheet.getCell(5, startCol + 1 + fi)
        fieldCell.value = label
        fieldCell.font = { bold: true }
        fieldCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PIVOT_COLORS.gray } }
        fieldCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
        columnWidths.push(20)
      })

      col = endCol + 1
    })

    sheet.getRow(3).height = 22
    sheet.getRow(4).height = 40
    sheet.getRow(5).height = 30

    columnWidths.forEach((w, i) => { sheet.getColumn(i + 1).width = w })

    let dataRow = 6

    perCustomer.forEach(({ customerName, tableRows }) => {
      const rowByCode = groupRowsByQuestionCode(tableRows)

      const nameCell = sheet.getCell(dataRow, 1)
      nameCell.value = customerName
      nameCell.font = { bold: true, color: { argb: PIVOT_COLORS.greenFont } }

      let c = 2

      group.questions.forEach(def => {
        const row = rowByCode.get(def.questionCode)

        const answerCell = sheet.getCell(dataRow, c)
        answerCell.value = row?.yes_no || ''
        answerCell.font = { color: { argb: PIVOT_COLORS.greenFont } }
        c++

        const valueByLabel = new Map((row?.field_details_pairs || []).map(p => [p.label, p.value]))

        def.fieldLabels.forEach(label => {
          const cell = sheet.getCell(dataRow, c)
          cell.value = valueByLabel.get(label) || ''
          cell.font = { color: { argb: PIVOT_COLORS.greenFont } }
          c++
        })
      })

      dataRow++
    })

    // A thick divider on the last column of every question's group (Answer +
    // its fields) makes the boundary between one question and the next
    // visually obvious — confined to the header rows (question code, question
    // text, Answer/field-name), stopping there rather than running down
    // through every customer row.
    questionEndCols.forEach(endCol => {
      for (let r = 3; r <= 5; r++) {
        const cell = sheet.getCell(r, endCol)
        cell.border = { ...cell.border, right: { style: 'medium', color: { argb: 'FF334155' } } }
      }
    })

    sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 5 }]
  })

  const buffer = await workbook.xlsx.writeBuffer()
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

export function QuestionnaireExportDialog({
  open,
  onClose,
  rows,
  selectedCustomerIds,
  reportName,
}: {
  open: boolean
  onClose: () => void
  rows: Record<string, unknown>[]
  selectedCustomerIds: Set<number>
  reportName: string
}) {
  const [scope, setScope] = useState<Scope>('all')
  const [format, setFormat] = useState<Format>('excel')
  const [structure, setStructure] = useState<Structure>('single')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [failures, setFailures] = useState<string[]>([])
  const { label: customerLabel } = useModuleName('customers')

  useEffect(() => {
    if (open) {
      setScope(selectedCustomerIds.size > 0 ? 'selected' : 'all')
      setFormat('excel')
      setStructure('single')
      setBusy(false)
      setProgress(null)
      setFailures([])
    }
  }, [open, selectedCustomerIds.size])

  if (!open) return null

  const targetRows = scope === 'selected'
    ? rows.filter(r => selectedCustomerIds.has(Number(r.customer_id)))
    : rows

  // Print produces a single browser print job — "one file per customer"
  // doesn't apply to it, so printing always runs as a single consolidated
  // document (still one customer per page).
  const structureLocked = format === 'print'
  const effectiveStructure: Structure = structureLocked ? 'single' : structure

  // Both "Single file" and "Separate file per customer" need the same full
  // Q&A detail per customer (not just the summary row visible in the report
  // table) — fetched once here, then either combined into one document (one
  // customer per page) or written out as one workbook/PDF per customer
  // (separate, zipped).
  async function runExport() {
    setBusy(true)
    setFailures([])
    setProgress({ done: 0, total: targetRows.length })

    try {
      const perCustomer: { customerName: string; tableRows: ReturnType<typeof buildQuestionTableRows> }[] = []
      const failed: string[] = []

      for (let i = 0; i < targetRows.length; i++) {
        const row = targetRows[i]
        const customerId = Number(row.customer_id)
        const customerName = String(row.customer_name ?? `Customer ${customerId}`)

        try {
          const res = await questionnaireApi.getCustomerQuestionnaire(customerId)
          const data = res.data as CustomerQAResponse
          perCustomer.push({ customerName, tableRows: buildQuestionTableRows(data) })
        } catch {
          failed.push(customerName)
        }

        setProgress({ done: i + 1, total: targetRows.length })
      }

      setFailures(failed)

      const nonEmptyPerCustomer = perCustomer.filter(({ tableRows }) => tableRows.length)

      const sections: ExportSection[] = nonEmptyPerCustomer
        .map(({ customerName, tableRows }) => ({
          heading: customerName,
          columns: PER_CUSTOMER_COLUMNS,
          rows: tableRows.map(r => PER_CUSTOMER_COLUMNS.map(c => formatCellValue((r as Record<string, unknown>)[c.key]))),
        }))

      if (effectiveStructure === 'single') {
        if (format === 'excel') {
          if (nonEmptyPerCustomer.length) {
            const blob = await buildQuestionnaireWorkbook(nonEmptyPerCustomer, reportName)
            saveAs(blob, `${safeFileName(reportName)}_${todayStamp()}.xlsx`)
          }
        } else if (sections.length) {
          if (format === 'pdf') {
            downloadBlob(buildSectionedPdfBlob(sections, reportName), `${safeFileName(reportName)}_${todayStamp()}.pdf`)
          } else {
            printSections(sections, reportName)
          }
        }
      } else {
        const files = sections.map(section => ({
          name: `${safeFileName(section.heading)}.${format === 'excel' ? 'xls' : 'pdf'}`,
          blob: format === 'excel'
            ? buildExcelBlob(section.columns, section.rows, section.heading)
            : buildPdfBlob(section.columns, section.rows, section.heading),
        }))

        if (files.length) {
          await zipAndDownload(files, `${safeFileName(reportName)}_Export_${todayStamp()}.zip`)
        }
      }

      if (!failed.length) {
        onClose()
      }
    } finally {
      setBusy(false)
    }
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

          {/* Scope */}
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Scope</div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
                All {customerLabel} ({rows.length})
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

          {/* Format */}
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

          {/* File structure */}
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">File Structure</div>
            <div className="space-y-1.5">
              <label className={`flex items-center gap-2 text-sm ${structureLocked ? 'text-slate-300' : 'text-slate-700'}`}>
                <input type="radio" checked={effectiveStructure === 'single'} disabled={structureLocked} onChange={() => setStructure('single')} />
                Single file (one customer per page)
              </label>
              <label className={`flex items-center gap-2 text-sm ${structureLocked ? 'text-slate-300' : 'text-slate-700'}`}>
                <input type="radio" checked={effectiveStructure === 'separate'} disabled={structureLocked} onChange={() => setStructure('separate')} />
                Separate file for each customer (ZIP)
              </label>
            </div>
          </div>

          {progress && (
            <div className="text-[12px] text-slate-500">
              Fetching questionnaire data — {progress.done} / {progress.total} customers…
            </div>
          )}

          {!!failures.length && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[12px] text-rose-600">
              Could not export: {failures.join(', ')}
            </div>
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
            disabled={busy || !targetRows.length}
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
