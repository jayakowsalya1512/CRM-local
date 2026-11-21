// Deals (prototype v17 · Sales → Deals) – /api/v1/deals
import api from '@/services/api'

export interface Stage { id: number; name: string; kind: 'open' | 'won' | 'lost'; sla: number; gate: 'None' | 'Approval' | 'Checklist'; owner_role: string | null; checklist: string[]; prob: number }
export interface Pipeline { key: string; name: string; label: string; destination: 'tender' | 'quotation'; active?: boolean; stages: Stage[] }
export interface Meta {
  company: string | null; views: string[]; pipelines: Pipeline[]; me: { id: number; name: string }; lost: { required: boolean; reasons: string[] }
  can: { create: boolean; update: boolean; delete: boolean; export: boolean; documents: boolean; log_activity: boolean; customers: boolean; configure: boolean }
}
export interface Row {
  id: number; ref: string; name: string; customer: string; customer_id: number | null; workflow: string; pipeline: string; destination: string
  value: number; prob: number; stage: string; stage_id: number; stage_kind: string; owner: string; owner_id: number | null; close: string | null
  pending: boolean; converted: boolean; sla: 'ok' | 'due' | 'breached' | null
  /** configured pipeline (Pipelines & Stages) – the prototype "Flow" column */
  flow: string; model: string; vertical: string; jid: string
  journey: { id: string; steps: { k: string; label: string; done: boolean; stage: string | null; ref?: string | null; me?: boolean }[] }
}
export interface ListParams { view: string; pipeline?: string; stage: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface Detail {
  id: number; ref: string; name: string; customer: string | null; customer_id: number | null; lead_status: string
  pipeline: { key: string; name: string; label: string; destination: string }; stages: Stage[]; stage: Stage
  kpis: { value: number; prob: number; weighted: number; close: string | null; close_in: number | null; type: string; model: string | null; vertical: string | null; age: number; created: string | null }
  progress: { index: number; of: number; kind: string }; sla: { sla: number; days: number; left: number; state: string } | null
  pending: { kind: 'stage' | 'conversion'; stage?: string | null; target?: string | null } | null
  signals: { t: string; s: string }[]
  journey: { k: string; label: string; ref: string | null; stage: string | null; value?: number | null; date?: string | null; route?: string | null; done: boolean }[]
  panels: { t: string; i: string; f: [string, unknown, string?][] }[]
  timeline: { d: string | null; t: string; by: string }[]; notes: { id: number; body: string; by: string; by_id?: number | null; at: string | null; legacy?: boolean }[]
  can_convert: boolean; convert_label: string; lost: { reason: string | null; note: string | null } | null
  form: { name: string; customer_id: number | null; customer_name: string | null; pipeline: string; value: number; close: string | null; owner_id: number | null
    owner_name: string | null; source_id: number | null; source_name: string | null; emd_required: boolean; custom_data: Record<string, unknown> }
  can: { update: boolean; delete: boolean; documents: boolean; log_activity: boolean; customers: boolean }
}
export interface DealInput { name: string; customer_id: number; pipeline: string; value: number | null; close: string | null; owner_id: number | null; source_id: number | null; emd_required: boolean; custom_data?: Record<string, unknown> | null }
export interface StageResult { status: 'moved' | 'pending' | 'unchanged'; stage: string; pending_stage?: string; message?: string; next?: { destination: string; label: string } }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
export const errDetail = (e: any): Record<string, any> => { const d = e?.response?.data?.detail; return d && typeof d === 'object' && !Array.isArray(d) ? d : {} }

const B = '/deals'
const MULTI = { headers: { 'Content-Type': 'multipart/form-data' } }
export const dealApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; value_total: number }>(`${B}/list`, {
    params: { view: p.view, pipeline: p.pipeline || '', stage: p.stage, q: p.q, offset: p.offset, limit: p.limit, f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '',
      adv: p.adv.conds.length ? JSON.stringify(p.adv) : '', sorts: p.sorts.length ? JSON.stringify(p.sorts) : '' },
  }).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/${id}`).then(r => r.data),
  create: (b: DealInput) => api.post<{ id: number; ref: string }>(B, b).then(r => r.data),
  update: (id: number, b: DealInput) => api.put<{ id: number }>(`${B}/${id}`, b).then(r => r.data),
  field: (id: number, field: 'close', value: string) => api.patch(`${B}/${id}/field`, { field, value }).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/${id}`).then(r => r.data),
  stage: (id: number, body: { stage_id: number; reason?: string; comment?: string; checklist?: string[] }) => api.post<StageResult>(`${B}/${id}/stage`, body).then(r => r.data),
  convert: (id: number) => api.post<{ message?: string; status: string; approval_status: string | null; tender_id?: number | null; tender_num?: string | null; direct?: boolean }>(`${B}/${id}/convert`).then(r => r.data),
  documents: (id: number) => api.get<{ items: { id: string; name: string; folder: string; updated_at: string | null; url: string; type: string; size_kb: number | null; owner: string }[]; allowed: boolean }>(`${B}/${id}/documents`).then(r => r.data),
  upload: (id: number, file: File) => { const fd = new FormData(); fd.append('file', file); fd.append('linked_source', 'leads'); fd.append('linked_record_id', String(id)); fd.append('name', file.name); return api.post('/document-management/upload', fd, MULTI).then(r => r.data) },
  note: (id: number, body: string) => api.post<{ id: number; mentioned: number }>(`${B}/${id}/notes`, { body }).then(r => r.data),
  editNote: (id: number, noteId: number, body: string) => api.put(`${B}/${id}/notes/${noteId}`, { body }).then(r => r.data),
  bulk: (ids: number[], action: 'reassign' | 'delete', value?: string) => api.post<{ done: number; failed: { id: number; error: string }[] }>(`${B}/bulk`, { ids, action, value }).then(r => r.data),
  duplicates: (customer_id: number, name: string, exclude_id?: number) => api.get<{ items: { id: number; ref: string; name: string; same_name: boolean }[] }>(`${B}/duplicates`, { params: { customer_id, name, exclude_id } }).then(r => r.data.items),
  customers: (q: string) => api.get<{ items: { id: number; name: string }[] }>(`${B}/customers`, { params: { q, limit: 50 } }).then(r => r.data.items),
  importCsv: (file: File, dryRun: boolean) => { const fd = new FormData(); fd.append('file', file); return api.post<ImportResult>(`${B}/import`, fd, { ...MULTI, params: { dry_run: dryRun } }).then(r => r.data) },
  template: () => api.get(`${B}/import/template`, { responseType: 'blob' }).then(r => r.data as Blob),
  logActivity: (body: Record<string, unknown>) => api.post('/kam/activities', body).then(r => r.data),
}
export interface ImportResult { created: number; dry_run: boolean; duplicates: { row: number; name: string; error: string }[]; errors: { row: number; name: string; error: string }[]; error_count: number; duplicate_count: number }

// prototype formatting
export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.00$/, '.0')} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }
export const dto = (d: string) => Math.round((new Date(`${d.slice(0, 10)}T00:00:00`).getTime() - new Date(`${todayIso()}T00:00:00`).getTime()) / 864e5)
// prototype pc(): stage / status → pill colour
const PILLC: Record<string, string[]> = {
  ok: ['Active', 'Won', 'Approved', 'Completed', 'Accepted', 'Converted', 'Qualified', 'Done', 'Closed'],
  wa: ['Pending', 'Prospect', 'Draft', 'Review', 'Nurturing', 'Contacted', 'Evaluation', 'Waiting'],
  ba: ['Lost', 'Rejected', 'Expired', 'Overdue', 'Failed', 'Disqualified', 'No-Go'],
}
export const pc = (s: string) => Object.keys(PILLC).find(k => PILLC[k].includes(s)) || 'inf'
export const stagePill = (name: string, kind?: string) => kind === 'won' ? 'ok' : kind === 'lost' ? 'ba' : pc(name)
export const probColor = (p: number) => p >= 60 ? 'var(--bw-ok)' : p >= 30 ? 'var(--bw-wa)' : 'var(--bw-ba)'
