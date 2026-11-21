// Travel & Expense (prototype v17 · Finance & Field → Travel & Expense) – /api/v1/travel-expense
import api from '@/services/api'

export const TRT = ['Requests', 'Expense claims', 'Calendar'] as const
export type TrTab = typeof TRT[number]

export interface Meta {
  company: string | null; me: { id: number; name: string }; views: string[]; statuses: string[]; modes: string[]; heads: string[]
  travellers: { id: number; name: string; department: string }[]; finance: boolean; max_receipt_mb: number
  can: { create: boolean; update: boolean; delete: boolean; export: boolean }
}
export interface Row { id: number; code: string; traveller: string; traveller_id: number; purpose: string; from: string; to: string; start: string | null; end: string | null; mode: string; cost: number; status: string; raw_status: string }
export interface ClaimRow { id: number; code: string; traveller: string; purpose: string; claimed: number; advance: number; advance_requested: number; balance: number; claim: string; claim_id: number | null; claim_no: string | null; items: number; can_submit: boolean }
export interface Receipt { id: number; name: string; url: string; type: string; size_kb: number | null }
export interface Detail {
  id: number; code: string; purpose: string; status: string; raw_status: string; company: string | null; traveller: string; traveller_id: number
  department: string | null; manager: string | null; from: string; to: string; start: string | null; end: string | null; mode: string; cost: number
  advance: number; advance_issued: number; advance_adjusted: number; advance_outstanding: number; claimed: number; balance: number
  rejection_reason: string | null; approved_by: string | null; approved_at: string | null; created_at: string | null; created_by: string | null
  claim: { id: number; no: string; label: string; status: string; reason: string | null; net_payable: number; payment_date: string | null; payment_reference: string | null } | null
  expenses: { id: number; head: string; amount: number; date: string | null; description: string; claim_id: number; receipts: Receipt[] }[]
  documents: (Receipt & { by: string; at: string | null; expense: string })[]
  advance_txns: { id: number; kind: 'disbursed' | 'refunded'; amount: number; date: string | null; reference: string | null; mode: string | null; by: string }[]
  activity: { t: string; by: string; d: string | null }[]; notes: { id: number; body: string; by: string; at: string | null }[]
  actions: { edit: boolean; delete: boolean; submit: boolean; complete: boolean; add_expense: boolean; submit_claim: boolean; advance: boolean; note: boolean }
}
export interface TripInput { traveller_id: number | null; purpose: string; from: string; to: string; start: string; end: string; mode: string; cost: string; advance: string }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d.length) return d.map((x: any) => x?.msg || String(x)).join('; ')
  return e?.message && !/status code/i.test(e.message) ? e.message : fallback
}

const B = '/travel-expense'
export const trApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (view: string, status: string) => api.get<{ items: Row[]; total_all: number; counts: Record<string, number> }>(`${B}/trips`, { params: { view, status } }).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/trips/${id}`).then(r => r.data),
  create: (b: TripInput) => api.post<{ id: number; code: string; status: string; message?: string }>(`${B}/trips`, b).then(r => r.data),
  update: (id: number, b: TripInput) => api.put<{ id: number; status: string; message?: string }>(`${B}/trips/${id}`, b).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/trips/${id}`).then(r => r.data),
  complete: (id: number) => api.post(`${B}/trips/${id}/complete`).then(r => r.data),
  addExpense: (id: number, b: { head: string; amount: string; date: string; description: string }) => api.post<{ id: number; claim_id: number }>(`${B}/trips/${id}/expenses`, b).then(r => r.data),
  delExpense: (id: number, item: number) => api.delete(`${B}/trips/${id}/expenses/${item}`).then(r => r.data),
  receipt: (id: number, item: number, file: File, docType = 'Receipt') => {
    const fd = new FormData(); fd.append('file', file)
    return api.post(`${B}/trips/${id}/expenses/${item}/receipts`, fd, { params: { doc_type: docType }, headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
  submitClaim: (id: number) => api.post<{ message: string; requested_to: string; overall_status: string; claim: string }>(`${B}/trips/${id}/claim/submit`).then(r => r.data),
  advance: (id: number, b: { kind: 'disbursed' | 'refunded'; amount: string; date: string; reference: string; mode: string }) => api.post(`${B}/trips/${id}/advance`, b).then(r => r.data),
  note: (id: number, body: string) => api.post<{ notes: Detail['notes'] }>(`${B}/trips/${id}/notes`, { body }).then(r => r.data),
  claims: () => api.get<{ kpis: { claimed: number; outstanding: number; awaiting: number }; items: ClaimRow[] }>(`${B}/claims`).then(r => r.data),
  calendar: () => api.get<{ items: Row[] }>(`${B}/calendar`).then(r => r.data.items),
}

export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const todayIso = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}` }
/** Prototype pc(): status pill tones (Pending amber, Approved / Completed green). */
export const tone = (s: string) => ({ Approved: 'ok', Completed: 'ok', Pending: 'wa', Draft: 'mu', Rejected: 'ba', Cancelled: 'mu' } as Record<string, string>)[s] || 'inf'
/** Money typed by a user: digits with at most two decimals (validated again by the server). */
export const moneyOk = (s: string, positive = false) => /^\d{1,9}(\.\d{1,2})?$/.test(s.trim()) && (!positive || Number(s) > 0)
