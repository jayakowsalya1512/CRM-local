/**
 * reportExport.ts — standalone Excel/PDF blob builders + ZIP bundling used by
 * the Questionnaire report's Export dialog (Report Engine). Kept separate from
 * DataTable.tsx's useExport() so the "separate file per customer" flow can
 * build many small workbooks/PDFs (one per customer) and zip them, without
 * touching the single-table export path every other report page relies on.
 */

import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import JSZip from 'jszip'

export interface ExportColumn {
  key:    string
  header: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  // Some browsers ignore clicks on detached anchors or cancel the download when the
  // URL is revoked straight away, so attach it and revoke once the download has started.
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Excel-openable HTML table, same technique as DataTable's exportExcel.
export function buildExcelBlob(
  columns: ExportColumn[],
  rows: string[][],
  sheetName: string,
  summaryLines: string[] = [],
): Blob {
  const colCount = columns.length || 1

  const summary = summaryLines.length
    ? `<tr><td colspan="${colCount}" style="padding:4px 12px;border:1px solid #e5e7eb;font-weight:bold;background:#F8FAFF">${summaryLines.map(escapeHtml).join(' &nbsp;·&nbsp; ')}</td></tr>`
    : ''

  const header = `<tr>${columns.map(c => `<th style="background:#1D4ED8;color:#fff;font-weight:bold;padding:8px 12px;border:1px solid #ddd">${escapeHtml(c.header)}</th>`).join('')}</tr>`

  const body = rows.map((r, i) =>
    `<tr style="background:${i % 2 === 0 ? '#fff' : '#F8FAFF'}">${r.map(v => `<td style="padding:6px 12px;border:1px solid #e5e7eb;white-space:pre-wrap">${escapeHtml(v).replace(/\n/g, '<br/>')}</td>`).join('')}</tr>`,
  )

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
    <head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
    <x:Name>${escapeHtml(sheetName).slice(0, 31)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
    </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
    <body><table>${summary}${header}${body.join('')}</table></body></html>`

  return new Blob([html], { type: 'application/vnd.ms-excel' })
}

export function buildPdfBlob(
  columns: ExportColumn[],
  rows: string[][],
  title: string,
  summaryLines: string[] = [],
): Blob {
  const doc = new jsPDF({
    orientation: columns.length > 6 ? 'landscape' : 'portrait',
    unit: 'pt',
  })

  doc.setFontSize(14)
  doc.text(title, 40, 32)
  doc.setFontSize(9)
  doc.setTextColor(107, 114, 128)
  doc.text(`Generated: ${new Date().toLocaleString()} · ${rows.length} records`, 40, 48)

  let startY = 60
  if (summaryLines.length) {
    doc.setFontSize(9)
    doc.setTextColor(55, 65, 81)
    doc.text(summaryLines.join('   ·   '), 40, 64)
    startY = 78
  }

  autoTable(doc, {
    startY,
    head: [columns.map(c => c.header)],
    body: rows,
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [29, 78, 216], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 255] },
    theme: 'grid',
  })

  return doc.output('blob')
}

export interface ExportSection {
  heading: string
  columns: ExportColumn[]
  rows:    string[][]
}

// One consolidated workbook, one customer per section — "mso-page-break-before"
// is a real Excel-recognized CSS extension for this HTML-table export format,
// so each section (after the first) opens on its own printed page in Excel.
export function buildSectionedExcelBlob(
  sections: ExportSection[],
  sheetName: string,
): Blob {
  const blocks = sections.map((section, idx) => {
    const colCount = section.columns.length || 1

    const heading = `<tr><td colspan="${colCount}" style="padding:8px 12px;background:#0f172a;color:#fff;font-weight:bold;font-size:13px;${idx > 0 ? 'mso-page-break-before:always;' : ''}">${escapeHtml(section.heading)}</td></tr>`

    const header = `<tr>${section.columns.map(c => `<th style="background:#1D4ED8;color:#fff;font-weight:bold;padding:8px 12px;border:1px solid #ddd">${escapeHtml(c.header)}</th>`).join('')}</tr>`

    const body = section.rows.map((r, i) =>
      `<tr style="background:${i % 2 === 0 ? '#fff' : '#F8FAFF'}">${r.map(v => `<td style="padding:6px 12px;border:1px solid #e5e7eb;white-space:pre-wrap">${escapeHtml(v).replace(/\n/g, '<br/>')}</td>`).join('')}</tr>`,
    )

    return heading + header + body.join('')
  })

  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
    <head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
    <x:Name>${escapeHtml(sheetName).slice(0, 31)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
    </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>
    <body><table>${blocks.join('')}</table></body></html>`

  return new Blob([html], { type: 'application/vnd.ms-excel' })
}

// One consolidated PDF, one customer per page (doc.addPage() before every
// section but the first).
export function buildSectionedPdfBlob(
  sections: ExportSection[],
  mainTitle: string,
): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt' })

  sections.forEach((section, idx) => {
    if (idx > 0) doc.addPage()

    doc.setFontSize(13)
    doc.setTextColor(17, 24, 39)
    doc.text(section.heading, 40, 32)
    doc.setFontSize(8)
    doc.setTextColor(107, 114, 128)
    doc.text(`${mainTitle} · ${section.rows.length} questions`, 40, 46)

    autoTable(doc, {
      startY: 56,
      head: [section.columns.map(c => c.header)],
      body: section.rows,
      styles: { fontSize: 8, cellPadding: 5 },
      headStyles: { fillColor: [29, 78, 216], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 250, 255] },
      theme: 'grid',
    })
  })

  return doc.output('blob')
}

// Opens a print-ready window, one customer per printed page (CSS
// page-break-before), then triggers the browser print dialog — mirrors
// DataTable's printTable() but across multiple customer sections.
export function printSections(sections: ExportSection[], docTitle: string) {
  const blocks = sections.map((section, idx) => {
    const header = section.columns
      .map(c => `<th style="background:#1D4ED8;color:#fff;padding:8px 10px;font-size:11px;text-align:left;border:1px solid #ddd">${escapeHtml(c.header)}</th>`)
      .join('')

    const rows = section.rows
      .map((r, i) => `<tr style="background:${i % 2 === 0 ? '#fff' : '#f8faff'}">${r.map(v => `<td style="padding:6px 10px;font-size:10px;border:1px solid #e5e7eb;color:#374151;white-space:pre-wrap">${escapeHtml(v) || '—'}</td>`).join('')}</tr>`)
      .join('')

    return `<div style="${idx > 0 ? 'page-break-before:always;padding-top:20px;' : ''}">
      <h3 style="color:#111827;font-size:14px;margin-bottom:8px">${escapeHtml(section.heading)}</h3>
      <table style="width:100%;border-collapse:collapse"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>
    </div>`
  })

  const win = window.open('', '_blank')
  if (!win) return

  win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml(docTitle)}</title>
    <style>@media print{@page{margin:1cm}body{font-family:Arial,sans-serif}}</style></head>
    <body style="font-family:Arial,sans-serif;padding:20px">
    <h2 style="color:#111827;font-size:16px;margin-bottom:4px">${escapeHtml(docTitle)}</h2>
    <p style="color:#6b7280;font-size:11px;margin-bottom:16px">Generated: ${new Date().toLocaleString()}</p>
    ${blocks.join('')}
    </body></html>`)

  win.document.close()
  setTimeout(() => { win.focus(); win.print(); win.close() }, 500)
}

export async function zipAndDownload(
  files: { name: string; blob: Blob }[],
  zipFilename: string,
) {
  const zip = new JSZip()

  files.forEach(f => zip.file(f.name, f.blob))

  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, zipFilename)
}

// Filesystem-safe file name (customer names often contain "/", "&", etc.).
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'file'
}
