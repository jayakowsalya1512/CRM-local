// Correspondence (prototype v17 R.letters) – /api/v1/correspondence plus the existing /letters and /inbox endpoints.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }

export interface RegRow { id: number; ref: string; tpl: string; title: string; to: string; against: string; link_source: string | null; link_id: number | null; date: string | null; by: string; status: 'Draft' | 'Dispatched'; raw_status: string }
export interface TenderOpt { id: number; title: string; customer: string; no: string }
export interface MergeData { customer: string; tender_no: string; title: string; value: string; emd: string; date: string; ref_no: string; signatory: string; fields: string[]; customer_id?: number | null; label?: string }
export interface Template { id: number; name: string; subject?: string | null; template_body: string; category?: string; letter_type_id?: number | null }
export interface Campaign { id: number; n: string; aud: string; tpl: string; st: string; sent: number; open: number; click: number; reply: number; leads: number; at: string | null; by: string; recipients: number }
export interface Sequence { id: number; n: string; steps: { day: number; kind: string; text: string }[]; enrolled: number }

export const corrApi = {
  register: (p: { q: string; status: string; offset: number; limit: number }) => api.get<{ items: RegRow[]; total: number; counts: Record<string, number> }>('/correspondence/register', { params: p }).then(r => r.data),
  tenders: (q = '') => api.get<{ items: TenderOpt[] }>('/correspondence/tenders', { params: { q } }).then(r => r.data.items),
  mergeData: (tender_id: number | null) => api.get<MergeData>('/correspondence/merge-data', { params: tender_id ? { tender_id } : {} }).then(r => r.data),
  templates: () => api.get<Template[]>('/letters/templates').then(r => (Array.isArray(r.data) ? r.data : [])),
  createLetter: (d: Record<string, unknown>) => api.post<{ id: number; letter_no: string }>('/letters/letters', d).then(r => r.data),
  issueLetter: (id: number) => api.post(`/letters/letters/${id}/issue`),
  audiences: () => api.get<{ items: { k: string; l: string }[] }>('/correspondence/audiences').then(r => r.data.items),
  campaigns: () => api.get<{ items: Campaign[] }>('/correspondence/campaigns').then(r => r.data.items),
  createCampaign: (d: { name: string; audience: string; template_id: number | null; send: string; subject_a: string; subject_b: string; create_lead: boolean }) => api.post<{ id: number }>('/correspondence/campaigns', d).then(r => r.data),
  sendCampaign: (id: number) => api.post<{ sent: number }>(`/correspondence/campaigns/${id}/send`).then(r => r.data),
  sequences: () => api.get<{ items: Sequence[] }>('/correspondence/sequences').then(r => r.data.items),
  createSequence: (d: { name: string; steps: { day: number; kind: string; text: string }[] }) => api.post<{ id: number }>('/correspondence/sequences', d).then(r => r.data),
  enrol: (id: number, module: string, scope: string) => api.post<{ enrolled: number }>(`/correspondence/sequences/${id}/enrol`, { module, scope }).then(r => r.data),
  mailbox: () => api.get<{ flags: Record<string, boolean>; domain: string }>('/correspondence/mailbox').then(r => r.data),
  setFlag: (key: string, value: boolean) => api.put<{ key: string; value: boolean; note: string }>(`/correspondence/mailbox/${key}`, { value }).then(r => r.data),
}
