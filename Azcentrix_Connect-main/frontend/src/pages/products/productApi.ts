// Product & Price Books (prototype v18 · Sales → Product & Price Books) – /api/v1/products
import api from '@/services/api'

export interface Opt { id: number; name: string; sub?: string }
export interface MField { key: string; label: string; type: string; options: string[]; source: 'core' | 'com' | 'x' | 'custom'; on: boolean; req: boolean; help: string }
export interface MStatus { id?: number; name: string; color: string; lock: boolean }
export interface MCat { id?: number; name: string; internal: boolean }
export interface MStage { id?: number; name: string }
export interface Rules { log: boolean; quoteApproved: boolean; hideInternal: boolean; lockEdits: boolean; quoteDiscApproval: boolean; minMargin: number; discLimit: number; floorPolicy: 'Warn' | 'Block' | 'Approval' }
export interface Template { key: string; name: string; description: string; grouping: string; categories: number; stages: string[]; statuses: string[] }
export interface Model {
  template: string; name: string; description: string; grouping: string; roles: string[]; life: string[]; units: string[]; code: string; specs: string[][]
  rules: Rules; categories: MCat[]; stages: MStage[]; statuses: MStatus[]; lock: string; draft: string; review: string | null; final: string | null
  fields: MField[]; templates: Template[]; updated_at: string | null
}
export interface Summary { name: string; grouping: string; categories: number; stages: number; statuses: number; fields: number }
export interface Company { id: string; name: string; summary: Summary }
export interface Config { units: string[]; currencies: string[]; base_currency: string; approval_limit: number; min_margin: number; floor_policy: string }
export interface Lookups { categories: string[]; oems: Opt[]; units: string[]; availability: string[]; currencies: string[]; base_currency: string; statuses: string[]; book_types: string[]; book_statuses: string[] }
export interface Can { create: boolean; update: boolean; delete: boolean; export: boolean; configure: boolean }
export interface Meta { company: string; companies: Company[]; views: string[]; model: Model; config: Config; lookups: Lookups; can: Can; me: { id: number; name: string } }
export type Vals = Record<string, string | number | null | undefined>
export interface Row {
  id: number; code: string; name: string; cat: string; longDesc: string; features: string; coo: string; policy: string; guide: string; supply: string
  status: string; pending_status: string | null; unit: string; list: number | null; cost: number | null; margin: number; oem: string; oem_id: number | null
  stock: string; gst: number | null; x: Record<string, string>; used: number; primary: number; updated_at: string | null
}
export interface Kpi { products: number; lock_label: string; approved: number; approved_pct: number; review: number; review_label: string | null; draft: number; draft_label: string; categories: number; avg_margin: number }
export interface ListResult { items: Row[]; total: number; total_all: number; counts: Record<string, number>; status_counts: { name: string; count: number }[]; kpi: Kpi; min_margin: number }
export interface ListParams { view: string; status: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface Spec { id?: number; p: string; v: string; u: string; std: string; rm: string }
export interface Mapping { id?: number; category_id: number | ''; cat?: string; internal?: boolean; stage_id: number | ''; stage?: string; role: string; rm: string }
export interface LogRow { id: string; date: string | null; product_id: number | null; code: string; name: string; book: string; field: string; old: string; new: string; reason: string; by: string; by_id: number | null; approver: string; approval: string }
export interface Window { id: number; reason: string; status: 'pending' | 'open'; approver: string; opened_at: string | null }
export interface Detail extends Row {
  fields: Vals; company: string; specs: Spec[]; mappings: Mapping[]; log: LogRow[]; locked: boolean; lock_status: string; window: Window | null; missing: string[]; floor: number | null
  actions: { next: string | null; next_label?: string | null; final: string | null; return: string | null }
  pricing: { id: number; name: string; applies_to: string; adjustment: number; currency: string; status: string; price: number | null; override: boolean; margin: number | null }[]
  quotes: { id: number; number: string; rev: number; status: string; customer: string }[]
  created_by_name: string; updated_by_name: string; created_at: string | null; can: Can
}
export interface Matrix {
  model: string; grouping: string; active: number; has_internal: boolean; categories: { id: number; name: string; internal: boolean; products: number }[]
  stages: { id: number; name: string }[]; cells: Record<string, { id: number; code: string; name: string; role: string; rm: string }[]>; unmapped: { id: number; code: string; name: string }[]
}
export interface Book {
  id: number; name: string; currency: string; rate: number | null; adjustment: number; is_default: boolean; approval: 'active' | 'pending' | 'rejected'; pending_adjustment: number | null
  type: string; valid_from: string | null; valid_to: string | null; applies_to: string; status: 'Draft' | 'Active' | 'Expired'; overrides: number
}
export interface BookRow { id: number; code: string; name: string; status: string; list: number | null; cost: number | null; price: number | null; margin: number | null; override: number | null; pending: number | null; floor: number | null; below_floor: boolean }
export interface BookDetail extends Book { rows: BookRow[]; approval_limit: number; min_margin: number; floor_policy: string; base_currency: string }
export interface ImpRow { row: number; code: string; name: string; category: string; status: string; action: 'add' | 'update' | 'unchanged'; changes?: string[]; errors: string[]; warnings: string[] }
export interface ImpSub { row: number; code: string; errors: string[] }
export interface ImportPreview { file: string; products: ImpRow[]; mappings: ImpSub[]; specs: ImpSub[]; add: number; update: number; unchanged: number; error_rows: number; ok: boolean; dry_run: boolean; added?: number; updated?: number }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

const B = '/products'
const MULTI = { headers: { 'Content-Type': 'multipart/form-data' } }
export const productApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<ListResult>(`${B}/list`, {
    params: { view: p.view, status: p.status, q: p.q, offset: p.offset, limit: p.limit, f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '',
      adv: p.adv.conds.length ? JSON.stringify(p.adv) : '', sorts: p.sorts.length ? JSON.stringify(p.sorts) : '' },
  }).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/${id}`).then(r => r.data),
  create: (values: Vals, stage: number | null) => api.post<{ id: number; code: string }>(B, { values, stage }).then(r => r.data),
  update: (id: number, values: Vals) => api.put<{ id: number; changed: number }>(`${B}/${id}`, { values }).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/${id}`).then(r => r.data),
  bulk: (ids: number[]) => api.post<{ done: number; failed: { id: number; error: string }[] }>(`${B}/bulk`, { ids, action: 'delete' }).then(r => r.data),
  specs: (id: number, rows: Spec[]) => api.put<{ specs: Spec[] }>(`${B}/${id}/specs`, { rows }).then(r => r.data.specs),
  mappings: (id: number, rows: Mapping[]) => api.put<{ mappings: Mapping[] }>(`${B}/${id}/mappings`, { rows }).then(r => r.data.mappings),
  status: (id: number, to: string, reason: string) => api.post<{ status: string; pending: string | null; message: string }>(`${B}/${id}/status`, { to, reason }).then(r => r.data),
  openWindow: (id: number, reason: string) => api.post<{ window: Window; message: string }>(`${B}/${id}/change-window`, { reason }).then(r => r.data),
  closeWindow: (id: number) => api.post(`${B}/${id}/change-window/close`).then(r => r.data),
  matrix: (internal: boolean) => api.get<Matrix>(`${B}/matrix`, { params: { internal } }).then(r => r.data),
  changelog: (p: { product_id?: number | ''; user_id?: number | ''; date_from?: string; date_to?: string; q?: string }) =>
    api.get<{ items: LogRow[]; users: Opt[]; products: { id: number; code: string; name: string }[] }>(`${B}/changelog`, { params: Object.fromEntries(Object.entries(p).filter(([, v]) => v !== '' && v != null)) }).then(r => r.data),
  model: () => api.get<Model>(`${B}/model`).then(r => r.data),
  saveModel: (b: Partial<Omit<Model, 'templates' | 'lock' | 'draft' | 'review' | 'final' | 'updated_at' | 'template' | 'description'>> & { currencies?: string[] }) =>
    api.put<Model & { config: Config }>(`${B}/model`, b).then(r => r.data),
  applyTemplate: (template: string) => api.post<Model>(`${B}/model/template`, { template }).then(r => r.data),
  addField: (label: string, type: string, required: boolean) => api.post<Model>(`${B}/model/fields`, { label, type, required }).then(r => r.data),
  template: (products = true) => api.get(`${B}/template`, { params: { products }, responseType: 'blob' }).then(r => ({ blob: r.data as Blob, name: /filename="([^"]+)"/.exec(String(r.headers['content-disposition'] || ''))?.[1] || 'Product_Master.xlsx' })),
  importXlsx: (file: File, dryRun: boolean) => { const fd = new FormData(); fd.append('file', file); return api.post<ImportPreview>(`${B}/import`, fd, { ...MULTI, params: { dry_run: dryRun } }).then(r => r.data) },
  exportCsv: (view: string, status: string) => api.get(`${B}/export`, { params: { view, status }, responseType: 'blob' }).then(r => r.data as Blob),
  books: () => api.get<{ items: Book[]; config: Config }>(`${B}/books/all`).then(r => r.data),
  book: (id: number) => api.get<BookDetail>(`${B}/books/${id}`).then(r => r.data),
  createBook: (b: { name: string; type: string; adjustment: number; currency: string; valid_to: string; applies_to: string }) => api.post<Book & { message: string | null }>(`${B}/books`, b).then(r => r.data),
  patchBook: (id: number, b: Partial<{ adjustment: number; valid_from: string; valid_to: string; status: string; applies_to: string; rate: number }>) =>
    api.patch<Book & { message: string | null }>(`${B}/books/${id}`, b).then(r => r.data),
  deleteBook: (id: number) => api.delete(`${B}/books/${id}`).then(r => r.data),
  override: (bookId: number, productId: number, price: number | null) => api.put<{ ok: boolean; message: string | null; row: BookRow | null }>(`${B}/books/${bookId}/products/${productId}`, { price }).then(r => r.data),
}

export const download = (blob: Blob, name: string) => {
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000)
}

// prototype formatting
export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
/** money in a price book's currency (INR keeps the prototype ₹ L / Cr format) */
export const money = (v: number | null | undefined, cur: string) => {
  if (v == null) return '—'
  if (cur === 'INR') return inr(v)
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v) } catch { return `${cur} ${Math.round(v).toLocaleString('en-IN')}` }
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const fdt = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
export const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
/** record-status pill tone from the company's configured statuses */
export const stTone = (m: Model | null | undefined, s: string) => m?.statuses.find(x => x.name === s)?.color || 'inf'
/** margin tone: below the minimum margin → bad, below 25 % → warn (prototype pxCatalogue) */
export const mgTone = (m: number, min: number) => m < min ? 'tbad' : m < 25 ? 'twarn' : 'tok'
export const STATUS_TONES: [string, string][] = [['mu', 'Grey'], ['wa', 'Amber'], ['ok', 'Green'], ['inf', 'Blue'], ['ba', 'Red']]
