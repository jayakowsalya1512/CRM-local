// Customers & Contacts (prototype v17) – typed calls to /api/v1/customer360.
import api from '@/services/api'

export const VIEWS = ['All', 'My accounts', 'Tier A', 'At risk'] as const
export type View = typeof VIEWS[number]

export interface Meta {
  company: string | null; views: View[]; statuses: string[]; tiers: string[]; types: string[]
  users: { id: number; name: string }[]; me: { id: number; name: string }
  levels: string[]; kam_modes: string[]; buying_roles: string[]
  can: { create: boolean; update: boolean; delete: boolean; export: boolean }
}
export interface Row {
  id: number; ref: string; company: string; name: string; type: string; city: string; kam: string; kam_id: number | null; kam_own: boolean
  tier: string; revenue: number; health: number; status: string; pending: boolean
  root: string; root_id: number | null; level: string; badge: [string, string]; depth: number; below: number
  parent: string; parent_id: number | null; vertical: string; band: string; segment: string; sub_segment: string
}
export interface ListParams { view: View; status: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }

export type Kpi = { l: string; v: number | string | null; f: 'inr' | 'pct' | 'int' | 'ago' | 'text' | 'num'; dc?: string; note?: string }
export interface Step { k: string; label: string; done: boolean; stage: string | null; route: string | null }
export interface Journey { id: string; stage: string; kind: string; record_id: number; steps: Step[]; timeline: { date: string; text: string }[] }
export interface Contact { id: number; name: string; designation: string; department: string; buying_role: string | null; engagement: number; phone: string; email: string; is_primary: boolean }
export interface C360 {
  header: {
    id: number; ref: string; name: string; health: number; level: string; badge: [string, string]; path: { id: number; name: string }[]; below: number
    type: string; location: string; since: number | null; kam: { id: number | null; name: string | null; own: boolean; from: string | null }
    tier: string; segment: string; sub_segment: string; vertical: string; value_band: string; gst: string | null; credit_limit: number | null
    status: string; approval_status: string | null; kam_mode: string; parent_id: number | null
  }
  kpis: Kpi[]
  overview: {
    funnel: { l: string; v: number }[]; revenue6: { l: string; v: number }[]; pipeline: { l: string; v: number }[]
    position: { band: string; vertical: string; rank: number | null; of: number; rows: { m: string; f: string; t: number; s: number; v: number; hi: number }[] }
    open_items: { t: string; s: string; route: string }[]; timeline: { date: string; text: string; by: string; kind: string }[]
  }
  journeys: Journey[]; contacts: Contact[]
  deals: { id: number; name: string; value: number; stage: string; journey: { id: string; dots: boolean[] } | null; route: string }[]
  bids: { id: number; ref: string; value: number; stage: string; deadline: string | null; route: string }[]
  quotes: { id: number; ref: string; subject: string; stage: string; route: string }[]
  leads: { id: number; ref: string; interest: string; stage: string; route: string }[]
  orders: { id: number; ref: string; type: string; value: number; progress: number; billed: number; status: string; route: string }[]
  schedule: { milestone: string; pct: number | null; amount: number; due: string | null; received: number; awaiting: number; balance: number; status: string; wo_id: number }[]
  /** collected / awaiting / outstanding / due come from the Orders & Projects payment ledger (Finance-acknowledged receipts) */
  billing: { order_value: number; billed: number; collected: number; awaiting: number; outstanding: number; due: number; avg_delay: number | null; invoices: number; receipts: number }
  guarantees: { id: number; type: string; ref: string; bid: string; bank: string; amount: number; valid_until: string | null; status: string; route: string }[]
  activities: { id: number; date: string; type: string; notes: string; by: string; outcome: string; status: string; route: string }[]
  emails: { id: number; subject: string; from: string; sent: string | null; opens: number }[]
  plan: { goal: string; strategy: string; risks: string; white_space: string; updated_at: string | null; updated_by: string | null }
  health: { score: number; drivers: { n: string; v: number; why: string }[]; risks: { t: string; s: string }[] }
  can: { update: boolean; delete: boolean; log_activity: boolean; email: boolean; new_deal: boolean; documents: boolean; create: boolean }
}
export interface Segment {
  band: string; vertical: string; n_s: number; n_v: number; strip: Kpi[]
  peers_s: PeerRow[]; peers_v: PeerRow[]; top_s: { l: string; v: number; me: boolean }[]; top_v: { l: string; v: number; me: boolean }[]
  line: { labels: string[]; mine: number[]; v_avg: number[]; s_avg: number[] }
  grid: { vertical: string; cells: { band: string; n: number; rev: number; me: boolean }[] }[]; bands: string[]
  band_mix: { l: string; v: number }[]; vert_mix: { l: string; v: number }[]; health_bars: { l: string; v: number }[]; gaps: { t: string; s: string }[]
}
export interface PeerRow { m: string; f: string; mine: number; avg: number; best: number; hi: number }
export interface Hierarchy {
  root: { id: number; name: string }; strip: Kpi[]; current: number
  rows: { id: number; name: string; depth: number; parent: number | null; level: string; city: string; below: number; kam: string | null; kam_own: boolean; kam_from: string | null; revenue: number; pipeline: number; open: number; leads: number; deals: number; bids: number; orders: number }[]
  kams: { name: string; entities: number; own: number; common: number; revenue: number }[]
  kam_mode: string; has_parent: boolean; kam_id: number | null; users: { id: number; name: string }[]; levels: string[]; level: string; next_level: string
  segment: string; sub_segment: string
}
export interface Doc { id: string; name: string; source: string; record_label: string; updated_at: string | null; url: string; file_type: string; size_kb: number | null }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

const B = '/customer360'
export const custApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Row[]; total: number; total_all: number; counts: Record<View, number> }>(`${B}/list`, {
    params: {
      view: p.view, status: p.status, q: p.q, offset: p.offset, limit: p.limit,
      f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '', adv: p.adv.conds.length ? JSON.stringify(p.adv) : '',
      sorts: p.sorts.length ? JSON.stringify(p.sorts) : '',
    },
  }).then(r => r.data),
  field: (id: number, field: string, value: string) => api.patch<Row>(`${B}/${id}/field`, { field, value }).then(r => r.data),
  bulk: (ids: number[], action: 'reassign' | 'delete' | 'status' | 'tier', value?: string) => api.post<{ done: number; failed: { id: number; error: string }[] }>(`${B}/bulk`, { ids, action, value }).then(r => r.data),
  importCsv: (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post<{ created: number; errors: { row: number; customer?: string; error: string }[]; error_count: number }>(`${B}/import`, fd).then(r => r.data) },
  template: () => api.get(`${B}/import/template`, { responseType: 'blob' }).then(r => r.data as Blob),
  get: (id: number) => api.get<C360>(`${B}/${id}`).then(r => r.data),
  segment: (id: number) => api.get<Segment>(`${B}/${id}/segment`).then(r => r.data),
  hierarchy: (id: number) => api.get<Hierarchy>(`${B}/${id}/hierarchy`).then(r => r.data),
  setHierarchy: (id: number, body: { kam_mode?: string; kam_id?: number | null; level?: string }) => api.put<Hierarchy>(`${B}/${id}/hierarchy`, body).then(r => r.data),
  addChild: (id: number, body: { name: string; level: string; city: string; kam_mode: string; kam_id: number | null }) => api.post<{ id: number; name: string }>(`${B}/${id}/children`, body).then(r => r.data),
  addContact: (id: number, body: { name: string; designation: string; department: string; phone: string; email: string; buying_role: string | null }) => api.post<Contact>(`${B}/${id}/contacts`, body).then(r => r.data),
  setRole: (id: number, contactId: number, buying_role: string | null) => api.put(`${B}/${id}/contacts/${contactId}/role`, { buying_role }).then(r => r.data),
  savePlan: (id: number, field: string, value: string) => api.put<C360['plan']>(`${B}/${id}/plan`, { field, value }).then(r => r.data),
  documents: (id: number) => api.get<{ documents: Doc[] }>('/document-management', { params: { customer_id: id, limit: 200 } }).then(r => r.data.documents),
  logActivity: (body: Record<string, unknown>) => api.post('/kam/activities', body).then(r => r.data),
}

// ─── prototype formatting ─────────────────────────────────────────────────────
/** prototype inr(): ₹ with Cr / L */
export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(a >= 1e9 ? 0 : 2).replace(/\.?0+$/, '')} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const fmtKpi = (k: Kpi) => k.v == null || k.v === '' ? '—'
  : k.f === 'inr' ? inr(Number(k.v)) : k.f === 'pct' ? `${k.v}%` : k.f === 'ago' ? `${k.v} d ago` : k.f === 'num' ? String(Math.round(Number(k.v) * 10) / 10) : String(k.v)
/** prototype pc(): pill tone */
const PILL: Record<string, string> = {}
'Active Won Approved Completed Connected Closed Accepted Converted Done Paid Qualified Healthy Strategic Invoiced'.split(' ').forEach(s => { PILL[s] = 'ok' })
'Pending Prospect Draft Review Medium Evaluation Warning Aligned Submitted Pre-Bid Upcoming Growth Sent'.split(' ').forEach(s => { PILL[s] = 'wa' })
'Lost Rejected Expired Overdue Failed High Churned Encashed Cancelled Delayed'.split(' ').forEach(s => { PILL[s] = 'ba' })
'Dormant Released Inactive Low Maintain Renewed'.split(' ').forEach(s => { PILL[s] = 'mu' })
export const pc = (s: string | null | undefined) => PILL[String(s || '')] || 'inf'
