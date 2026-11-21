// Partners & OEM / Competitive Intel (prototype v17 Directory) – typed calls to /api/v1/directory.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const inr = (v: number | null | undefined) => {
  if (v == null) return '—'
  const a = Math.abs(v)
  if (a >= 1e7) return `₹${+(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${+(v / 1e5).toFixed(2)} L`
  return `₹${Math.round(v).toLocaleString('en-IN')}`
}
/** prototype dto(): days from today to a date */
export const dto = (d: string | null | undefined) => { if (!d) return null; const t = new Date(d.slice(0, 10) + 'T00:00:00'); const n = new Date(); n.setHours(0, 0, 0, 0); return Math.round((t.getTime() - n.getTime()) / 86400000) }

export interface Can { create: boolean; update: boolean; delete: boolean }
export interface ListQuery { view: string; category?: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface Page<R> { items: R[]; total: number; total_all: number; counts: Record<string, number> }

// ── Partners & OEM ──
export interface OemMeta { company: string; views: string[]; categories: string[]; statuses: string[]; can: Can }
export interface OemRow {
  id: number; name: string; type: string; category: string; contact: string; contact_email: string; contact_phone: string; auth: string | null; auth_number: string
  discount: number | null; rating: number; tenders: number; status: string; account_manager: string; payment_terms: string; support_sla: string; credit_limit: string
  notes: string; created: string | null; auth_state: string
}
export interface OemDetail extends OemRow { tender_list: { id: number; title: string; stage: string; value: number | null }[]; activity: { t: string; by: string; d: string | null }[]; can: Can }
export interface OemIn { name?: string; category?: string; contact?: string; auth?: string | null; discount?: number | null; rating?: number; status?: string; notes?: string }

// ── Competitive Intel ──
export interface CompMeta { company: string; views: string[]; can: Can }
export interface CompRow {
  id: number; name: string; hq: string; strength: string; weak: string; threat: string; website: string; oem: string; regions: string; notes: string; created: string | null
  met: number; won: number; lost: number; delta: number; share: number; wr: number
}
export interface CompDetail extends CompRow { encounters: { id: number; title: string; result: string | null; l1: string; ours: number | null; theirs: number | null }[]; activity: { t: string; by: string; d: string | null }[]; can: Can }
export interface CompIn { name?: string; hq?: string; strength?: string; weak?: string; notes?: string }

export const directoryApi = {
  oemMeta: () => api.get<OemMeta>('/directory/oems/meta').then(r => r.data),
  oems: (q: ListQuery) => api.post<Page<OemRow>>('/directory/oems/query', q).then(r => r.data),
  oem: (id: number) => api.get<OemDetail>(`/directory/oems/${id}`).then(r => r.data),
  createOem: (d: OemIn) => api.post<{ id: number }>('/directory/oems', d).then(r => r.data),
  updateOem: (id: number, d: OemIn) => api.put(`/directory/oems/${id}`, d).then(r => r.data),
  deleteOems: (ids: number[]) => api.post<{ deleted: number }>('/directory/oems/delete', { ids }).then(r => r.data),

  compMeta: () => api.get<CompMeta>('/directory/competitors/meta').then(r => r.data),
  comps: (q: ListQuery) => api.post<Page<CompRow>>('/directory/competitors/query', q).then(r => r.data),
  comp: (id: number) => api.get<CompDetail>(`/directory/competitors/${id}`).then(r => r.data),
  createComp: (d: CompIn) => api.post<{ id: number }>('/directory/competitors', d).then(r => r.data),
  updateComp: (id: number, d: CompIn) => api.put(`/directory/competitors/${id}`, d).then(r => r.data),
  deleteComps: (ids: number[]) => api.post<{ deleted: number }>('/directory/competitors/delete', { ids }).then(r => r.data),
}
