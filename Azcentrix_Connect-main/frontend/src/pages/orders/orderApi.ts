// Orders & Projects (prototype v17 · Sales → Orders & Projects) – /api/v1/orders
import api from '@/services/api'

export interface Stage { id: number; name: string; kind: 'open' | 'won'; sla: number; gate: 'None' | 'Approval' | 'Checklist'; owner_role: string | null; checklist: string[] }
export interface Lifecycle { key: string; type: string; label: string; trigger: 'manual' | 'closure' | 'won'; template: string | null; active: boolean; stages: Stage[]; orders?: number }
export interface OrderConfig {
  milestones: boolean; billing_model: string; retention: boolean; retention_pct: number; auto_pm: boolean; slip_alert: boolean; number_format: string; number_custom: string
}
export interface Can { create: boolean; update: boolean; delete: boolean; export: boolean; documents: boolean; log_activity: boolean; customers: boolean; configure: boolean }
export interface Meta {
  company: string | null; views: string[]; lifecycles: Lifecycle[]; me: { id: number; name: string }; config: OrderConfig; can: Can
  templates: string[]; triggers: Record<string, string>; billing_models: string[]; number_formats: string[]
}
export interface Row {
  id: number; ref: string; title: string; customer: string; customer_id: number | null; po: string; value: number; progress: number; billed: number; gap: number
  stage: string; stage_id: number; stage_kind: 'open' | 'won'; pm: string; pm_id: number | null; due: string | null; start: string | null; delayed: boolean
  lifecycle: string; type: string; pending: boolean; parent_id: number | null; jid: string | null
  /** prototype jTrack (L · D · T|Q · O) and colsOf Company column */
  journey: { id: string; steps: { k: string; label: string; done: boolean; stage: string | null; ref?: string | null; me?: boolean }[] } | null; company: string
  /** v18 payment collection: Finance-acknowledged receipts · receipts awaiting Finance */
  received: number; awaiting: number; pending_receipts: number
}
// ── v18 · payment collection ────────────────────────────────────────────────
export type RcptStatus = 'Pending finance' | 'Acknowledged' | 'Not credited'
export interface PayStage { id: number; name: string; pct: number; amount: number; due: string | null; invoice_ref: string; received: number; awaiting: number; balance: number; status: string; overdue: boolean; receipts: number }
export interface Receipt {
  id: number; wo_id: number; stage_id: number | null; stage: string; amount: number; date: string | null; mode: string; ref: string; remarks: string
  by: string; by_id: number | null; entered_by: string; recorded_at: string | null; status: RcptStatus; ack_by: string; ack_at: string | null
  bank_date: string | null; bank_ref: string; credited_to: string; ack_remarks: string; original_amount: number | null
}
export interface PayCan { record: boolean; plan: boolean; finance: boolean }
export interface Against { kind: 'tender' | 'quote'; id: number; ref: string; title: string }
export interface Payments {
  order: { id: number; ref: string; customer: string; value: number; start: string | null; due: string | null; collected_by: number | null }
  plan: 'Single' | 'Stage-wise'; against: Against | null
  totals: { value: number; due: number; received: number; awaiting: number; outstanding: number; overdue: number; received_pct: number; with_awaiting_pct: number }
  stages: PayStage[]; receipts: Receipt[]; modes: string[]; templates: Record<string, [string, number][]>; can: PayCan; accounts: string[]
}
type OrderRef = { wo_id: number; order: string; customer: string; company: string; tender: string; tender_kind: 'tender' | 'quote' | null; tender_id: number | null }
export type SchedRow = OrderRef & { id: string; plan: string; stage_id: number; stage: string; pct: number; amount: number; due: string | null; received: number; awaiting: number; balance: number; status: string; invoice_ref: string }
export type RcptRow = OrderRef & Receipt
export interface Collections {
  kpis: { order_book: number; due: number; received: number; awaiting: number; awaiting_count: number; overdue: number; overdue_count: number; efficiency: number }
  queue: RcptRow[]; schedule: SchedRow[]; receipts: RcptRow[]; can: PayCan; modes: string[]; accounts: string[]; company: string; orders: number
}
export interface ReceiptInput { stage_id: number; amount: number; received_on: string; mode: string; reference: string; collected_by: number | null; remarks: string | null }
export interface AckInput { bank_date?: string | null; bank_ref?: string | null; credited_to?: string | null; credited_amount?: number | null; remarks?: string | null }
export interface PlanInput { plan: 'Single' | 'Stage-wise'; stages: { id: number | null; name: string; pct: number; due: string | null; invoice_ref: string | null }[] }
export interface RcptHistory { id: number; action: string; by: string; at: string | null; old: Record<string, unknown> | null; new: Record<string, unknown> | null; note: string }
export interface ListParams { view: string; type: string; stage: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface JStep { k: string; label: string; ref: string | null; route: string | null; stage: string | null; done: boolean; value?: number | null; date?: string | null; me?: boolean }
export interface Milestone { id: number; name: string; date: string | null; amount: number; done: boolean; status: 'Done' | 'Pending'; completed: string | null; notes: string; overdue: boolean
  invoice: { id: number; number: string; date: string | null; amount: number; status: string } | null }
export interface Invoice { id: number; number: string; date: string | null; amount: number; status: string; milestone_id: number | null }
export interface Detail {
  id: number; ref: string; title: string; customer: string; customer_id: number | null; po: string | null; value: number; start: string | null; due: string | null; due_in: number | null
  progress: number; billed: number; billed_amount: number; pm: string | null; pm_id: number | null; lifecycle: { key: string; type: string }; stages: Stage[]; stage: Stage
  stage_no: number; stages_of: number; pending: { stage: string | null; approval_request_id: number | null } | null; signals: { t: string; s: string }[]
  journey: { id: string | null; lead_id: number | null; steps: JStep[]; follow_ons: { id: number; ref: string; type: string; me: boolean; date: string | null }[] }
  panels: { t: string; i: string; f: [string, unknown, string?][] }[]; timeline: { t: string; by: string; d: string | null }[]
  notes: { id: number; body: string; by: string; by_id: number | null; at: string | null }[]; parent: { id: number; ref: string | null } | null
  follow_on_options: { key: string; type: string }[]; progress_basis: 'milestones' | 'stage' | 'manual'; config: { milestones: boolean; billing_model: string }
  form: { title: string; customer_id: number | null; customer_name: string; po: string; value: number | null; start: string | null; due: string | null; pm_id: number | null; pm_name: string | null; custom_data: Record<string, unknown> }
  can: Can
}
export interface OrderInput { title: string; customer_id: number; po: string | null; value: number | null; start: string | null; due: string | null; pm_id: number | null; lifecycle?: string | null; custom_data?: Record<string, unknown> | null }
export interface StageResult { status: 'moved' | 'pending' | 'unchanged'; stage: string; pending_stage?: string; message?: string; follow_ons?: { id: number; ref: string }[] }
export interface ImportResult { created: number; dry_run: boolean; duplicates: { row: number; name: string; error: string }[]; errors: { row: number; name: string; error: string }[]; error_count: number; duplicate_count: number }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
export const errDetail = (e: any): Record<string, any> => { const d = e?.response?.data?.detail; return d && typeof d === 'object' && !Array.isArray(d) ? d : {} }

const B = '/orders'
const MULTI = { headers: { 'Content-Type': 'multipart/form-data' } }
export const orderApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; type_counts: Record<string, number>; value_total: number; pending_finance: number }>(`${B}/list`, {
    params: { view: p.view, type: p.type, stage: p.stage, q: p.q, offset: p.offset, limit: p.limit, f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '',
      adv: p.adv.conds.length ? JSON.stringify(p.adv) : '', sorts: p.sorts.length ? JSON.stringify(p.sorts) : '' },
  }).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/${id}`).then(r => r.data),
  create: (b: OrderInput) => api.post<{ id: number; ref: string }>(B, b).then(r => r.data),
  update: (id: number, b: OrderInput) => api.put<{ id: number }>(`${B}/${id}`, b).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/${id}`).then(r => r.data),
  stage: (id: number, body: { stage_id: number; checklist?: string[] }) => api.post<StageResult>(`${B}/${id}/stage`, body).then(r => r.data),
  progress: (id: number, progress: number) => api.patch(`${B}/${id}/progress`, { progress }).then(r => r.data),
  milestones: (id: number) => api.get<{ items: Milestone[]; invoices: Invoice[]; invoiced: number }>(`${B}/${id}/milestones`).then(r => r.data),
  saveMilestone: (id: number, mid: number | null, b: { name: string; date: string | null; amount: number; done: boolean; notes?: string | null }) =>
    (mid ? api.put(`${B}/${id}/milestones/${mid}`, b) : api.post(`${B}/${id}/milestones`, b)).then(r => r.data),
  deleteMilestone: (id: number, mid: number) => api.delete(`${B}/${id}/milestones/${mid}`).then(r => r.data),
  invoice: (id: number, b: { number: string; date: string | null; amount: number; gst: number; milestone_id: number | null }) => api.post(`${B}/${id}/invoices`, b).then(r => r.data),
  followOn: (id: number, lifecycle: string) => api.post<{ id: number; ref: string; message: string }>(`${B}/${id}/follow-on`, { lifecycle }).then(r => r.data),
  documents: (id: number) => api.get<{ items: { id: string; name: string; folder: string; updated_at: string | null; url: string }[]; allowed: boolean }>(`${B}/${id}/documents`).then(r => r.data),
  upload: (id: number, file: File) => { const fd = new FormData(); fd.append('file', file); fd.append('linked_source', 'workorders'); fd.append('linked_record_id', String(id)); fd.append('name', file.name); return api.post('/document-management/upload', fd, MULTI).then(r => r.data) },
  note: (id: number, body: string) => api.post<{ id: number; mentioned: number }>(`${B}/${id}/notes`, { body }).then(r => r.data),
  editNote: (id: number, nid: number, body: string) => api.put(`${B}/${id}/notes/${nid}`, { body }).then(r => r.data),
  bulk: (ids: number[], action: 'reassign' | 'delete' | 'stage', value?: string) => api.post<{ done: number; failed: { id: number; error: string }[] }>(`${B}/bulk`, { ids, action, value }).then(r => r.data),
  customers: (q: string) => api.get<{ items: { id: number; name: string }[] }>(`${B}/customers`, { params: { q, limit: 50 } }).then(r => r.data.items),
  duplicates: (customer_id: number, title: string, po: string, exclude_id?: number) =>
    api.get<{ items: { id: number; ref: string; title: string; same_po: boolean; same_title: boolean }[] }>(`${B}/duplicates`, { params: { customer_id, title, po, exclude_id } }).then(r => r.data.items),
  importCsv: (file: File, dryRun: boolean) => { const fd = new FormData(); fd.append('file', file); return api.post<ImportResult>(`${B}/import`, fd, { ...MULTI, params: { dry_run: dryRun } }).then(r => r.data) },
  template: () => api.get(`${B}/import/template`, { responseType: 'blob' }).then(r => r.data as Blob),
  // v18 · payment collection
  collections: () => api.get<Collections>(`${B}/collections`).then(r => r.data),
  payments: (id: number) => api.get<Payments>(`${B}/${id}/payments`).then(r => r.data),
  savePlan: (id: number, b: PlanInput) => api.put<{ ok: boolean; moved: number }>(`${B}/${id}/payment-plan`, b).then(r => r.data),
  recordReceipt: (id: number, b: ReceiptInput) => api.post<{ id: number; status: RcptStatus }>(`${B}/${id}/receipts`, b).then(r => r.data),
  correctReceipt: (id: number, rid: number, b: ReceiptInput) => api.put<{ id: number; status: RcptStatus; changed: boolean }>(`${B}/${id}/receipts/${rid}`, b).then(r => r.data),
  acknowledge: (id: number, rid: number, b: AckInput) => api.post<{ id: number; status: RcptStatus }>(`${B}/${id}/receipts/${rid}/acknowledge`, b).then(r => r.data),
  notCredited: (id: number, rid: number, b: AckInput) => api.post<{ id: number; status: RcptStatus }>(`${B}/${id}/receipts/${rid}/not-credited`, b).then(r => r.data),
  receiptHistory: (id: number, rid: number) => api.get<{ items: RcptHistory[] }>(`${B}/${id}/receipts/${rid}/history`).then(r => r.data.items),
  config: () => api.get<OrderConfig & { can_configure: boolean; next_number: string }>(`${B}/config/settings`).then(r => r.data),
  saveConfig: (b: Partial<OrderConfig>) => api.put<OrderConfig>(`${B}/config/settings`, b).then(r => r.data),
  lifecycles: () => api.get<{ items: Lifecycle[]; templates: string[]; triggers: Record<string, string> }>(`${B}/config/lifecycles`).then(r => r.data),
  newLifecycle: (b: { name: string; template: string; trigger: string }) => api.post<Lifecycle>(`${B}/config/lifecycles`, b).then(r => r.data),
  deleteLifecycle: (key: string) => api.delete<{ moved: number }>(`${B}/config/lifecycles/${key}`).then(r => r.data),
}

// prototype inr(): ₹x.xx Cr / ₹x.x L / ₹n,nn,nnn
export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }
export const dto = (d: string) => Math.round((new Date(`${d.slice(0, 10)}T00:00:00`).getTime() - new Date(`${todayIso()}T00:00:00`).getTime()) / 864e5)
/** prototype pill(): the closing stage is ok; other names use the shared pc() colour map (Kit Pill falls back to it). */
export const stagePill = (_name: string, kind?: string) => kind === 'won' ? 'ok' : ''
/** prototype PYC (payment stage status) and PYR (receipt Finance status) pill tones */
export const PYC: Record<string, string> = { 'Received': 'ok', 'Awaiting finance': 'inf', 'Part paid': 'wa', 'Part paid · overdue': 'ba', 'Overdue': 'ba', 'Due soon': 'wa', 'Scheduled': 'mu' }
export const PYR: Record<string, string> = { 'Pending finance': 'wa', 'Acknowledged': 'ok', 'Not credited': 'ba' }
export const pct = (a: number, b: number) => b ? Math.round(a / b * 100) : 0
export const addDays = (iso: string, n: number) => { const d = new Date(`${iso.slice(0, 10)}T00:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
export const daysBetween = (a: string, b: string) => Math.round((new Date(`${b.slice(0, 10)}T00:00:00`).getTime() - new Date(`${a.slice(0, 10)}T00:00:00`).getTime()) / 864e5)
