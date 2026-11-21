// Guarantees & Deposits (prototype v18 · Finance & Field → Guarantees & Deposits) – /api/v1/instruments
import api from '@/services/api'

export interface IType { key: string; label: string; stored: string; category: string; active: boolean; purpose: string }
export interface InsConfig {
  remind_days: number; track_margin: boolean; release_approval: boolean; auto_create: boolean; preferred_bank: string; escalate_days: number; track_fdr: boolean
  banks: string[]; accounts: string[]; finance_roles: string[]; alert_expiring: boolean; alert_expired: boolean; alert_refund: boolean; alert_received: boolean; alert_finance: boolean; alert_email: boolean
}
export interface Can { view: boolean; create: boolean; update: boolean; finance: boolean; forfeit: boolean; export: boolean; settings: boolean; sensitive: boolean }
export interface Meta {
  company: string | null; companies: { id: string; name: string }[]; views: string[]; statuses: string[]; tones: Record<string, string>; types: IType[]; modes: string[]; exempt_mode: string
  ret_reasons: string[]; recv_modes: string[]; banks: string[]; accounts: string[]; config: InsConfig; preferred_banks: string[]; high_value: number; me: { id: number; name: string }; can: Can
}
export interface Row {
  id: number; code: string; type: string; type_key: string; tender_id: number | null; tender: string; tender_no: string; wo_id: number | null; wo: string; customer: string
  mode: string; amount: number; bank: string; requested: string | null; requested_by: string; due: string | null; approved_on: string | null; approved_by: string; utr: string
  validity: string | null; status: string; eff_status: string; tone: string; expired: boolean; days: number | null; bg: boolean; live: boolean; next: string
  ret_on: string | null; recv_on: string | null; recv_by: string; recv_amount: number | null; recv_ref: string; priority: string; approval_id: number | null
}
export interface Kpi { l: string; n: number; v: number; view: string; c: string; filter?: { type_key: string; status: string } }
export interface Alert { c: string; t: string; n: number; view: string; items: { id: number; s: string }[] }
export interface Summary { outstanding: number; live: number; groups: { k: string; l: string; v: number; n: number }[]; kpis: Kpi[]; alerts: Alert[]; counts: Record<string, number> }
export interface ListParams { view: string; type: string; status: string; validity: string; link: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface Desk { summary: Summary; finance_pay: Row[]; finance_ack: Row[]; expiring: Row[]; refunds: Row[]; collections_pending: number; today: string }
export interface DepCell { req: string; amount: number | null; id?: number; status?: string; tone?: string }
export interface TenderRow { id: number; ref: string; title: string; customer: string; stage: string; stage_kind: string; submit: string | null; emd: DepCell; fee: DepCell; bg: DepCell; gate: { ok: boolean; missing: string[] } }
export interface Option { id: number; ref: string; customer: string; title: string; stage?: string; po?: string; value?: number }
export interface Defaults { amount: number | null; mode: string; due: string | null; bene: string; at: string; bank: string; customer: string; tender_no: string; rule: string; req?: string; cert?: string }
export interface Detail extends Row {
  purpose: string; bene: string; at: string; ref: string; remarks: string; margin_pct: number | string | null; margin_amount: number | string | null; charges: number | string | null
  debit_account: string; exempt_cert: string
  dates: { recorded: string | null; recorded_by: string; due: string | null; approved: string | null; approved_by: string; sent_to_finance: string | null; paid: string | null; paid_by: string
    validity: string | null; refund_requested: string | null; received: string | null; received_by: string; received_amount: number | null; acknowledged: string | null; acknowledged_by: string
    forfeited: string | null; forfeited_by: string }
  receipt: { mode: string; ref: string; remarks: string; ack_ref: string; ack_amount: number | string | null; ack_account: string; shortfall: number | null; ack_remarks: string }
  refund: { reason: string; letter: string; pending_approval: boolean }; forfeit: { reason: string }
  approval: { id: number | null; status: string | null; chain: { step: number; role: string; user: string; state: string; at: string | null; remarks: string }[]; requested_by: string; requested_at: string | null; priority: string; rejection: string }
  extension: { pending_date: string | null; approval_request_id: number | null }; extensions: { old: string | null; new: string | null; notes: string | null; at: string | null }[]
  tender_rec: { id: number; ref: string; title: string; nit: string; customer: string; portal: string; value: number; stage: string; submit: string | null; owner: string; timeline: { d: string | null; l: string; s: string; c: string }[] } | null
  order_rec: { id: number; ref: string; work: string; customer: string; po: string; value: number; due: string | null } | null
  timeline: { t: string; by: string; d: string | null }[]
  actions: { open_approval: boolean; withdraw: boolean; resubmit: boolean; pay: boolean; refund: boolean; receive: boolean; extend: boolean; forfeit: boolean; acknowledge: boolean }
  can: Can; form: { amount: number | null; mode: string; due: string | null; bene: string; at: string; bank: string; remarks: string }; today: string
}
type Body = Record<string, string | number | boolean | null | undefined>

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

const B = '/instruments'
export const insApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Row[]; total: number; total_all: number; summary: Summary }>(`${B}/list`, {
    params: { view: p.view, type: p.type, status: p.status, validity: p.validity, link: p.link, q: p.q, offset: p.offset, limit: p.limit,
      f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '', adv: p.adv.conds.length ? JSON.stringify(p.adv) : '', sorts: p.sorts.length ? JSON.stringify(p.sorts) : '' },
  }).then(r => r.data),
  desk: () => api.get<Desk>(`${B}/summary`).then(r => r.data),
  byTender: () => api.get<{ items: TenderRow[] }>(`${B}/by-tender`).then(r => r.data.items),
  options: () => api.get<{ tenders: Option[]; orders: Option[] }>(`${B}/options`).then(r => r.data),
  defaults: (type: string, tender_id: number | null, wo_id: number | null) => api.get<Defaults>(`${B}/defaults`, { params: { type, ...(tender_id ? { tender_id } : {}), ...(wo_id ? { wo_id } : {}) } }).then(r => r.data),
  create: (b: Body) => api.post<{ id: number; code: string; status: string; message: string }>(B, b).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/${id}`).then(r => r.data),
  withdraw: (id: number) => api.post<{ message: string }>(`${B}/${id}/withdraw`).then(r => r.data),
  resubmit: (id: number, b: Body) => api.post<{ message: string }>(`${B}/${id}/resubmit`, b).then(r => r.data),
  pay: (id: number, b: Body) => api.post(`${B}/${id}/pay`, b).then(r => r.data),
  refund: (id: number, b: Body) => api.post<{ status: string; message: string }>(`${B}/${id}/refund-request`, b).then(r => r.data),
  receive: (id: number, b: Body) => api.post(`${B}/${id}/receive`, b).then(r => r.data),
  acknowledge: (id: number, b: Body) => api.post<{ shortfall: number }>(`${B}/${id}/acknowledge`, b).then(r => r.data),
  extend: (id: number, validity: string, reason: string) => api.post<{ status: string; message: string }>(`${B}/${id}/extend`, { validity, reason }).then(r => r.data),
  forfeit: (id: number, b: Body) => api.post(`${B}/${id}/forfeit`, b).then(r => r.data),
  exportCsv: (p: Partial<ListParams>) => api.get(`${B}/export`, { params: { view: p.view, type: p.type, status: p.status, validity: p.validity, link: p.link, q: p.q }, responseType: 'blob' }).then(r => r.data as Blob),
  config: () => api.get<InsConfig & { preferred_banks: string[]; can_configure: boolean }>(`${B}/config/settings`).then(r => r.data),
  saveConfig: (b: Partial<InsConfig>) => api.put<InsConfig>(`${B}/config/settings`, b).then(r => r.data),
}

// prototype formatting
export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const fdS = (d: string | null | undefined) => { if (!d) return '—'; const [, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]}` }
export const fdt = (s: string | null) => s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
export const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
export const addDays = (iso: string | null | undefined, n: number) => { const d = iso ? new Date(`${iso.slice(0, 10)}T00:00:00`) : new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
/** days from today (negative = past) – prototype dto() */
export const dto = (iso: string | null | undefined) => { if (!iso) return 0; const a = new Date(`${iso.slice(0, 10)}T00:00:00`).getTime(), b = new Date(`${todayIso()}T00:00:00`).getTime(); return Math.round((a - b) / 864e5) }
export const download = (blob: Blob, name: string) => { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000) }
/** prototype PAL colours of the outstanding bar (EMD · Bid security BG · PBG · Security deposit · FDR) */
export const GROUP_COLOR: Record<string, string> = { EMD: '#0F6E8C', BG: '#7A4DB8', PBG: '#1B8559', SD: '#B26B00', FDR: '#3E63A8', OTHER: '#6B7D2A' }
