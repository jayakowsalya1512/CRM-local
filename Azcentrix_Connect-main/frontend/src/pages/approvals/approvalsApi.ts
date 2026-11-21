// Approvals (prototype v18 · Automation & Control → Approvals) – typed calls to /api/v1/approvals360.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const ft = (d: string | null | undefined) => (d && d.length >= 16 ? d.slice(11, 16) : '')
export const inr = (v: number | null | undefined) => { if (v == null) return '—'; const a = Math.abs(v); return a >= 1e7 ? `₹${+(v / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `₹${+(v / 1e5).toFixed(2)} L` : `₹${Math.round(v).toLocaleString('en-IN')}` }

export interface Purpose { k: string; l: string; i: string; c: string }
export interface ChainStep { step: number; user: string; user_id: number | null; role: string; state: string; date: string | null; comment: string; current: boolean }
export interface Sla { left: number; txt: string; cls: string; hours: number; due: string | null }
export interface Row {
  key: string; id: string; src: 'legacy' | 'flow'; type: string; title: string; module: string; ref: string; route: string | null; cust: string; value: number | null; stage: string
  pp: string; by: string; byRole: string; by_id: number; req: string | null; cur: string; curRole: string; cur_id: number | null; chain: ChainStep[]; sla: Sla
  priority: string; status: string; notes: string; decided: string | null; from: string; to: string; policy: string; escalated: boolean; info_open: boolean
}
export interface Section { t: string; i: string; kv?: [string, string][]; chk?: [string, string, string][]; diff?: [string, unknown, unknown][]; contacts?: { name: string; role: string; phone: string; email: string }[]; link?: { t: string; to: string | null } | null }
export interface Detail extends Row {
  purpose: Purpose & { why: string }; what: string; sections: Section[]; history: { t: string; d: string | null; by: string }[]; step: { done: number; of: number }
  company: string; source: string; info: { open: boolean; question: string | null }; escalation: { status: string | null; at: string | null }
  can_decide: boolean; can_delegate: boolean; can_escalate: boolean; can_answer: boolean; self_blocked: boolean; quick_remarks: string[]
}
export interface Prefs { tab: string; sort: string; cat: string; next: 'next' | 'close'; hide: string[]; away: boolean; away_to: number | null; away_till: string | null; remarks: string[] }
export interface NotifyPrefs { app: boolean; email: boolean; digest: boolean; digest_time: string | null; whatsapp: boolean; whatsapp_available: boolean }
export interface Meta {
  views: string[]; purposes: Purpose[]; sorts: Record<string, string>; people: { id: number; name: string; role: string }[]; me: { id: number; name: string; role: string }
  prefs: Prefs; notify: NotifyPrefs; quick_remarks: Record<string, string[]>; can: { policies: boolean; export: boolean }
}
export interface Kpis { mine: number; pending: number; value: number; overdue: number; approved: number; rejected: number; turnaround: number | null }
export interface Query { view: string; q: string; purpose: string; status: string; priority: string; requester: number | null; approver: number | null; date_from: string | null; date_to: string | null
  sla: string; decided_days: number | null; sort: string; offset: number; limit: number }
export interface QueryResult { items: Row[]; total: number; base: number; purposes: (Purpose & { n: number })[] }

const B = '/approvals360'
export const approvalsApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  kpis: () => api.get<Kpis>(`${B}/kpis`).then(r => r.data),
  query: (q: Query) => api.post<QueryResult>(`${B}/query`, q).then(r => r.data),
  exportCsv: (q: Query) => api.post(`${B}/export`, q, { responseType: 'blob' }).then(r => r.data as Blob),
  detail: (key: string) => api.get<Detail>(`${B}/${key}`).then(r => r.data),
  decide: (key: string, decision: 'approved' | 'rejected', remarks: string) => api.post(`${B}/${key}/decide`, { decision, remarks }),
  delegate: (key: string, user_id: number, remarks: string, until: string | null) => api.post<{ to: string }>(`${B}/${key}/delegate`, { user_id, remarks, until }).then(r => r.data),
  escalate: (key: string, text: string) => api.post<{ to: string }>(`${B}/${key}/escalate`, { text }).then(r => r.data),
  askInfo: (key: string, text: string) => api.post(`${B}/${key}/ask-info`, { text }),
  answer: (key: string, text: string) => api.post(`${B}/${key}/answer`, { text }),
  prefs: () => api.get<Prefs & { notify: NotifyPrefs }>(`${B}/prefs`).then(r => r.data),
  savePrefs: (p: Prefs & { notify: Partial<NotifyPrefs> }) => api.put<Prefs & { notify: NotifyPrefs }>(`${B}/prefs`, p).then(r => r.data),
  resetPrefs: () => api.post<Prefs & { notify: NotifyPrefs }>(`${B}/prefs/reset`).then(r => r.data),
}
