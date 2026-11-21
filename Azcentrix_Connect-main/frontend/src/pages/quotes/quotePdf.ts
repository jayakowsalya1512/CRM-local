// Quotation PDF (prototype qprint → "Generate PDF"): tenant letterhead (logo, name, domain, primary address), reference
// and revision, date, customer, subject, enquiry, line items (Qty · Rate · Disc % · Amount), sub-total, GST and total,
// commercial terms and the authorised sender. Built from /quotes/{id}/pdf-data, so it always shows saved values.
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { buildApiAssetUrl } from '@/services/api'
import { fd, num, type PdfData } from './quoteApi'

const loadImage = (url: string) => new Promise<{ data: string; w: number; h: number } | null>(resolve => {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d')!.drawImage(img, 0, 0)
      resolve({ data: c.toDataURL('image/png'), w: img.naturalWidth, h: img.naturalHeight })
    } catch { resolve(null) }
  }
  img.onerror = () => resolve(null)
  img.src = url
})
// jsPDF's standard fonts have no ₹ glyph – amounts are printed as "Rs." in the PDF.
const rs = (v: number) => `Rs. ${num(v)}`

export async function buildQuotePdf(d: PdfData): Promise<Blob> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth(), M = 42
  let y = 46
  const logo = d.logo ? await loadImage(buildApiAssetUrl(d.logo) || d.logo) : null
  if (logo) { const h = 34, w = Math.min(120, logo.w * h / logo.h); doc.addImage(logo.data, 'PNG', W - M - w, y - 14, w, h) }
  doc.setFont('times', 'bold'); doc.setFontSize(16); doc.text(d.company || 'Company', M, y)
  doc.setFont('times', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90)
  if (d.domain) { y += 13; doc.text(d.domain, M, y) }
  if (d.address) { y += 12; doc.text(doc.splitTextToSize(d.address, W - 2 * M - 130), M, y) }
  y += 14; doc.setDrawColor(200); doc.line(M, y, W - M, y); y += 20
  doc.setTextColor(20); doc.setFontSize(10.5)
  doc.text(`Ref: ${d.ref}/Rev ${d.rev}  ·  Date: ${fd(d.date)}${d.valid_till ? `  ·  Valid till: ${fd(d.valid_till)}` : ''}`, M, y); y += 20
  doc.text('To:', M, y); doc.setFont('times', 'bold'); doc.text(d.customer || '—', M + 20, y); doc.setFont('times', 'normal')
  if (d.customer_address) { y += 13; const a = doc.splitTextToSize(d.customer_address, W - 2 * M - 20); doc.text(a, M + 20, y); y += (a.length - 1) * 12 }
  y += 15
  const subj = doc.splitTextToSize(`Subject: ${d.subject}${d.enquiry ? ` (Enquiry ${d.enquiry})` : ''}`, W - 2 * M)
  doc.text(subj, M, y); y += subj.length * 13 + 4
  autoTable(doc, {
    startY: y, margin: { left: M, right: M }, theme: 'grid',
    head: [['#', 'Description', 'Qty', 'Rate (Rs.)', 'Disc %', 'Amount (Rs.)']],
    body: d.lines.map(l => [String(l.n), l.description, String(l.qty), num(l.rate), l.disc ? `${l.disc}` : '—', num(l.amount)]),
    styles: { font: 'times', fontSize: 9.5, cellPadding: 4, lineColor: [204, 204, 204], textColor: 20 },
    headStyles: { fillColor: [244, 244, 244], textColor: 20, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 24 }, 2: { halign: 'right', cellWidth: 44 }, 3: { halign: 'right', cellWidth: 78 }, 4: { halign: 'right', cellWidth: 46 }, 5: { halign: 'right', cellWidth: 86 } },
  })
  y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY || y) + 16
  const right = (label: string, v: string, bold = false) => { doc.setFont('times', bold ? 'bold' : 'normal'); doc.text(label, W - M - 170, y); doc.text(v, W - M, y, { align: 'right' }); y += 14 }
  right('Sub-total', rs(d.sub)); right(d.gst_label, rs(d.gst)); doc.setFontSize(11.5); right(`Total incl. GST`, rs(d.total), true); doc.setFontSize(10.5)
  const terms = ([['Payment', d.terms.payment], ['Delivery', d.terms.delivery], ['Validity', d.valid_till ? fd(d.valid_till) : null], ['Warranty', d.terms.warranty]] as [string, string | null][])
    .filter(t => t[1])
  if (terms.length) {
    y += 8; if (y > 720) { doc.addPage(); y = 50 }
    doc.setFont('times', 'bold'); doc.text('Commercial terms', M, y); y += 14; doc.setFont('times', 'normal')
    for (const [k, v] of terms) { const t = doc.splitTextToSize(`${k}: ${v}`, W - 2 * M); if (y + t.length * 12 > 790) { doc.addPage(); y = 50 } doc.text(t, M, y); y += t.length * 12 + 2 }
  }
  y += 22; if (y > 750) { doc.addPage(); y = 60 }
  doc.text('Yours faithfully,', M, y); y += 15
  doc.setFont('times', 'bold'); doc.text(d.sender.name || '', M, y); doc.setFont('times', 'normal')
  for (const x of [d.sender.designation, d.sender.email, d.sender.phone].filter(Boolean)) { y += 12; doc.setFontSize(9.5); doc.text(x, M, y) }
  return doc.output('blob')
}
