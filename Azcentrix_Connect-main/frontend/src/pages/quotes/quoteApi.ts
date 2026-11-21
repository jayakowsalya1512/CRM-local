// Quotes (prototype v17 · Sales → Quotes) – /api/v1/quotes
import api from '@/services/api'
import type { Journey } from '@/pages/leads/JourneyTrack'

export interface Stage { id: number; name: string; kind: 'open' | 'won' | 'lost'; sla: number; gate: 'None' | 'Approval' | 'Checklist'; owner_role: string | null; checklist: string[] }
export interface QuoteConfig { gst_percent: number | null; validity_days: number | null; max_discount: number | null; payment: string | null; delivery: string | null; warranty: string | null }
export interface Can { create: boolean; update: boolean; delete: boolean; export: boolean; documents: boolean; workorders: boolean; configure: boolean }
export interface Meta { company: string | null; views: string[]; stages: Stage[]; me: { id: number; name: string }; lost: { required: boolean; reasons: string[] }; config: QuoteConfig; can: Can }
export interface Row {
  id: number; ref: string; subject: string; customer: string; customer_id: number | null; rev: number; revs: number; value: number
  stage: string; stage_id: number; stage_kind: string; owner: string; owner_id: number | null; valid_till: string | null; pending: boolean; enquiry: string; lead_id: number | null
  /** prototype Journey column (L · D · Q · O) */
  jid: string | null; journey: Journey; company: string
}
export interface ListParams { view: string; stage: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface Line { id: number; description: string; qty: number; rate: number; disc: number; tax: number; amount: number; product_id: number | null }
export interface Revision { id: number; n: number; rev_no: number; date: string | null; by: string; by_id: number | null; note: string; approval_status: string; latest: boolean; sub: number; gst: number; total: number; lines: Line[] }
export interface JStep { k: string; label: string; ref: string | null; stage: string | null; value: number | null; date: string | null; route: string | null; note: string | null; done: boolean; me?: boolean }
export interface Detail {
  id: number; ref: string; subject: string; customer: string; customer_id: number | null; company: string | null; enquiry: string; valid_till: string | null
  owner: string; owner_id: number | null; stage: Stage; stages: Stage[]; pending: { stage: string | null; approval_request_id: number | null } | null
  lost: { reason: string | null; note: string | null } | null; revisions: Revision[]; editable: boolean; edit_block: string | null
  terms: { payment: string | null; delivery: string | null; warranty: string | null; custom: Record<'payment' | 'delivery' | 'warranty', string | null>; defaults: Record<'payment' | 'delivery' | 'warranty', string | null> }
  config: { gst_percent: number | null; max_discount: number | null }; work_order: { id: number; number: string; status: string } | null
  can_send: boolean; send_target: string | null; journey: { id: string; steps: JStep[] }; history: { t: string; by: string; d: string | null }[]
  custom: [string, unknown][]; form: { subject: string; customer_id: number | null; customer_name: string; enquiry: string; valid_till: string | null; owner_id: number | null; owner_name: string; custom_data: Record<string, unknown> }
  lead_id: number | null; tender_id: number | null; can: Can
  /** prototype recHero('quotes') */
  hero: { total: number; rev: number; versions: number; valid_till: string | null; valid_in: number | null; customer: string; owner: string
    kind: string; pct: number; stage_no: number; stages_of: number; flow: string; signals: { t: string; s: string }[] }
}
export interface QuoteInput { subject: string; customer_id: number; enquiry: string | null; valid_till: string | null; owner_id: number | null; custom_data?: Record<string, unknown> | null; deal_id?: number | null }
export interface StageResult { status: 'moved' | 'pending' | 'unchanged'; stage: string; pending_stage?: string; message?: string; next?: { label: string } }
export interface Product { id: number; sku?: string; code?: string; unit?: string; name: string; category: string; description: string; list: number | null; gst: number | null; stock: string
  status?: string; price?: number | null; override?: boolean; floor?: number | null; margin?: number | null }
/** Product & Price Books (v18): price books a quote line can use and the company's pricing rules */
export interface CatalogMeta { books: { id: number; name: string; adjustment: number; currency: string; type: string }[]; default_book: number | null; lock: string; model: string
  approved_only: boolean; disc_limit: number; min_margin: number; disc_approval: boolean }
export interface PdfData {
  company: string | null; domain: string | null; logo: string | null; address: string | null; ref: string; rev: number; rev_id: number; date: string | null; customer: string
  customer_address: string | null; subject: string; enquiry: string; valid_till: string | null; lines: { n: number; description: string; qty: number; rate: number; disc: number; tax: number; amount: number }[]
  sub: number; gst: number; total: number; gst_label: string; terms: { payment: string | null; delivery: string | null; warranty: string | null }
  sender: { name: string; designation: string; email: string; phone: string }
}
export interface Doc { id: number; name: string; url: string; type: string; rev: number | null; size_kb: number | null; by: string; at: string | null }
export interface ImportResult { created: number; dry_run: boolean; duplicates: { row: number; name: string; error: string }[]; errors: { row: number; name: string; error: string }[]; error_count: number; duplicate_count: number }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
export const errDetail = (e: any): Record<string, any> => { const d = e?.response?.data?.detail; return d && typeof d === 'object' && !Array.isArray(d) ? d : {} }

const B = '/quotes'
const MULTI = { headers: { 'Content-Type': 'multipart/form-data' } }
export const quoteApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; value_total: number }>(`${B}/list`, {
    params: { view: p.view, stage: p.stage, q: p.q, offset: p.offset, limit: p.limit, f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '',
      adv: p.adv.conds.length ? JSON.stringify(p.adv) : '', sorts: p.sorts.length ? JSON.stringify(p.sorts) : '' },
  }).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/${id}`).then(r => r.data),
  create: (b: QuoteInput) => api.post<{ id: number; ref: string }>(B, b).then(r => r.data),
  update: (id: number, b: QuoteInput) => api.put<{ id: number }>(`${B}/${id}`, b).then(r => r.data),
  duplicate: (id: number) => api.post<{ id: number; ref: string; message: string }>(`${B}/${id}/duplicate`).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/${id}`).then(r => r.data),
  stage: (id: number, body: { stage_id: number; reason?: string; comment?: string; checklist?: string[] }) => api.post<StageResult>(`${B}/${id}/stage`, body).then(r => r.data),
  sendForApproval: (id: number) => api.post<StageResult>(`${B}/${id}/send-for-approval`).then(r => r.data),
  newRevision: (id: number) => api.post<{ id: number; n: number; message: string }>(`${B}/${id}/revisions`).then(r => r.data),
  note: (id: number, revId: number, note: string) => api.patch(`${B}/${id}/revisions/${revId}/note`, { note }).then(r => r.data),
  addLine: (id: number, revId: number, body: { product_id?: number; description?: string; price_book_id?: number | null }) => api.post<{ id: number; warnings?: string[] }>(`${B}/${id}/revisions/${revId}/lines`, body).then(r => r.data),
  editLine: (id: number, revId: number, lineId: number, body: Partial<Record<'description' | 'qty' | 'rate' | 'disc' | 'tax', string | number>>) =>
    api.patch<{ ok: boolean; warnings?: string[] }>(`${B}/${id}/revisions/${revId}/lines/${lineId}`, body).then(r => r.data),
  deleteLine: (id: number, revId: number, lineId: number) => api.delete(`${B}/${id}/revisions/${revId}/lines/${lineId}`).then(r => r.data),
  terms: (id: number, body: { payment: string | null; delivery: string | null; warranty: string | null }) => api.put(`${B}/${id}/terms`, body).then(r => r.data),
  catalog: (q = '', bookId: number | null = null) => api.get<{ items: Product[] } & CatalogMeta>(`${B}/catalog`, { params: { q, ...(bookId ? { book_id: bookId } : {}) } }).then(r => r.data),
  pdfData: (id: number, revId: number) => api.get<PdfData>(`${B}/${id}/pdf-data`, { params: { rev_id: revId } }).then(r => r.data),
  uploadPdf: (id: number, revId: number, blob: Blob, name: string) => { const fd = new FormData(); fd.append('file', blob, name); return api.post<{ id: number; name: string; url: string }>(`${B}/${id}/revisions/${revId}/pdf`, fd, MULTI).then(r => r.data) },
  documents: (id: number) => api.get<{ items: Doc[]; allowed: boolean }>(`${B}/${id}/documents`).then(r => r.data),
  workOrder: (id: number) => api.post<{ id: number; wo_number: string; lead_id: number | null; tender_id: number | null; message: string }>(`${B}/${id}/work-order`).then(r => r.data),
  bulk: (ids: number[], action: 'reassign' | 'delete', value?: string) => api.post<{ done: number; failed: { id: number; error: string }[] }>(`${B}/bulk`, { ids, action, value }).then(r => r.data),
  customers: (q: string) => api.get<{ items: { id: number; name: string }[] }>(`${B}/customers`, { params: { q, limit: 50 } }).then(r => r.data.items),
  importCsv: (file: File, dryRun: boolean) => { const fd = new FormData(); fd.append('file', file); return api.post<ImportResult>(`${B}/import`, fd, { ...MULTI, params: { dry_run: dryRun } }).then(r => r.data) },
  template: () => api.get(`${B}/import/template`, { responseType: 'blob' }).then(r => r.data as Blob),
  config: () => api.get<QuoteConfig & { can_configure: boolean }>(`${B}/config/settings`).then(r => r.data),
  saveConfig: (b: Record<string, string>) => api.put<QuoteConfig>(`${B}/config/settings`, b).then(r => r.data),
}

// prototype formatting – inr(): ₹x.xx Cr / ₹x.x L / ₹n,nn,nnn
export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
/** prototype num(): full Indian grouping with 2 decimals (preview / PDF) */
export const num = (v: number) => Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }
const PILLC: Record<string, string[]> = {
  ok: ['Accepted', 'Won', 'Approved', 'Completed', 'Latest'],
  wa: ['Draft', 'Internal Review', 'Under Negotiation', 'Pending', 'Review'],
  ba: ['Rejected', 'Lost', 'Expired'],
}
export const pc = (s: string) => Object.keys(PILLC).find(k => PILLC[k].includes(s)) || 'inf'
export const stagePill = (name: string, kind?: string) => kind === 'won' ? 'ok' : kind === 'lost' ? 'ba' : pc(name)
/** Amount = Qty × Rate × (1 − Disc % / 100), rounded to paise (same rule as the server). */
export const lineAmount = (q: number, r: number, d: number) => Math.round(q * r * (1 - d / 100) * 100) / 100
