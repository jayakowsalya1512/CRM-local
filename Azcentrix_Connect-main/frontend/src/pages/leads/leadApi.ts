// Leads (prototype v17) – typed calls to /api/v1/lead360 and the existing Masters APIs.
import { useCallback, useEffect, useRef, useState } from 'react'
import api from '@/services/api'
import type { Journey } from './JourneyTrack'

/** A lead workflow stage (prototype v17): key = the status a move stores; values = every status shown in it. */
export interface Stage { key: string; label: string; kind: 'open' | 'won' | 'lost'; values: string[] }
export interface Meta {
  company: string | null; views: string[]; stages: Stage[]; hot_threshold: number; me: { id: number; name: string }
  can: { create: boolean; update: boolean; delete: boolean; documents: boolean; log_activity: boolean; customers: boolean }
  approval: { create: string[] | null; update: string[] | null }
  lost: { required: boolean; reasons: string[] }
}
export interface Row {
  id: number; ref: string; company: string; customer_id: number | null; contact: string; source: string; source_id: number | null
  interest: string; title: string; value: number; score: number; stage: string; owner: string; owner_id: number | null; follow_up: string | null; approval_status: string | null
  jid: string; journey: Journey; flow: string; model: string; vertical: string
}
export interface ListParams { view: string; stage: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface Detail {
  id: number; ref: string; company: string; customer_id: number | null; title: string; stage: string; approval_status: string | null; conversion_target: string | null
  kpis: { value: number; score: number; age: number; created: string; follow_up: string | null; follow_in: number | null; model: string | null; vertical: string | null }
  progress: { index: number; of: number }; stages: Stage[]; signals: { t: string; s: string }[]
  journey: { k: string; label: string; ref: string | null; stage: string | null; value?: number; date?: string; route?: string | null; done: boolean }[]
  panels: { t: string; i: string; f: [string, unknown, string?][] }[]
  timeline: { d: string | null; t: string; by: string }[]; notes: { id: number; body: string; by: string; at: string | null; legacy?: boolean }[]
  form: { customer_id: number | null; customer_name: string | null; contact_id: number | null; contact_person: string | null; source_id: number | null; est_value: number
    product_id: number | null; product_name: string | null; assigned_to: number | null; follow_up: string | null; custom_data: Record<string, unknown> }
  can: { update: boolean; delete: boolean; documents: boolean; log_activity: boolean }
}
export interface LeadInput { customer_id: number; contact_id: number | null; source_id: number | null; est_value: number | null; product_id: number | null; assigned_to: number | null; follow_up: string | null; custom_data?: Record<string, unknown> | null }
export type Opt = { id: number; name: string; sub?: string }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

const B = '/lead360'
const MULTI = { headers: { 'Content-Type': 'multipart/form-data' } }
export const leadApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Row[]; total: number; total_all: number; counts: Record<string, number>; value_total: number }>(`${B}/list`, {
    params: { view: p.view, stage: p.stage, q: p.q, offset: p.offset, limit: p.limit, f: Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '',
      adv: p.adv.conds.length ? JSON.stringify(p.adv) : '', sorts: p.sorts.length ? JSON.stringify(p.sorts) : '' },
  }).then(r => r.data),
  get: (id: number) => api.get<Detail>(`${B}/${id}`).then(r => r.data),
  create: (b: LeadInput) => api.post<{ id: number }>(B, b).then(r => r.data),
  update: (id: number, b: LeadInput) => api.put<{ id: number }>(`${B}/${id}`, b).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/${id}`).then(r => r.data),
  stage: (id: number, stage: string, reason?: string, comment?: string) => api.post(`${B}/${id}/stage`, { stage, reason: reason || null, comment: comment || null }).then(r => r.data),
  convert: (id: number, target: 'deal' | 'tender' | 'quotation') => api.post(`${B}/${id}/convert`, { target }).then(r => r.data),
  documents: (id: number) => api.get<{ items: { id: string; name: string; type: string; updated_at: string | null; url: string; size_kb: number | null; owner: string }[]; allowed: boolean }>(`${B}/${id}/documents`).then(r => r.data),
  upload: (id: number, file: File) => { const fd = new FormData(); fd.append('file', file); fd.append('linked_source', 'leads'); fd.append('linked_record_id', String(id)); fd.append('name', file.name); return api.post('/document-management/upload', fd, MULTI).then(r => r.data) },
  note: (id: number, body: string) => api.post<{ id: number; mentioned: number }>(`${B}/${id}/notes`, { body }).then(r => r.data),
  bulk: (ids: number[], action: 'reassign' | 'delete' | 'stage', value?: string, reason?: string, comment?: string) => api.post<{ done: number; failed: { id: number; error: string }[] }>(`${B}/bulk`, { ids, action, value, reason: reason || null, comment: comment || null }).then(r => r.data),
  duplicates: (customer_id: number, product_id: number | null, exclude_id?: number) => api.get<{ items: { id: number; ref: string; title: string; same_product: boolean }[] }>(`${B}/duplicates`, { params: { customer_id, product_id: product_id || undefined, exclude_id } }).then(r => r.data.items),
  importCsv: (file: File) => { const fd = new FormData(); fd.append('file', file); return api.post<{ created: number; errors: { row: number; company?: string; error: string }[]; error_count: number }>(`${B}/import`, fd, MULTI).then(r => r.data) },
  template: () => api.get(`${B}/import/template`, { responseType: 'blob' }).then(r => r.data as Blob),
  logActivity: (body: Record<string, unknown>) => api.post('/kam/activities', body).then(r => r.data),
}

// ─── Masters (loaded live – never hard-coded; re-read when the window regains focus) ──
export const masters = {
  customers: (q: string) => api.get<{ items: Opt[] }>(`${B}/customers`, { params: { q, limit: 50 } }).then(r => r.data.items),
  contacts: (customerId: number) => api.get<{ items: { id: number; name: string; designation: string; mobile: string; email: string; is_primary: boolean }[] }>(`${B}/contacts`, { params: { customer_id: customerId } })
    .then(r => r.data.items.map(c => ({ id: c.id, name: c.name, sub: [c.designation, c.mobile].filter(Boolean).join(' · ') }))),
  sources: () => api.get<{ id: number; name: string }[]>('/masters/lead-sources').then(r => r.data.map(s => ({ id: s.id, name: s.name }))),
  products: () => api.get<{ id: number; name: string; category?: string }[]>('/masters/products').then(r => r.data.map(p => ({ id: p.id, name: p.name, sub: p.category || '' }))),
  users: () => api.get<{ id: number; label: string; role?: string }[]>('/masters/users-for-select').then(r => r.data.map(u => ({ id: u.id, name: u.label, sub: u.role || '' }))),
}

export function useMaster(load: (() => Promise<Opt[]>) | null, deps: unknown[] = []) {
  const [items, setItems] = useState<Opt[] | null>(null)
  const [error, setError] = useState('')
  const ref = useRef(load)
  ref.current = load
  const reload = useCallback(() => {
    const fn = ref.current
    if (!fn) { setItems([]); setError(''); return }
    setItems(null); setError('')
    fn().then(setItems).catch(e => { setItems([]); setError(errMsg(e, 'Could not load the list')) })
  }, [])
  useEffect(() => { reload() }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const f = () => { if (ref.current) reload() }; window.addEventListener('focus', f); return () => window.removeEventListener('focus', f) }, [reload])
  return { items, error, reload, loading: items === null }
}

// ─── formatting (prototype inr / fd / dto) ────────────────────────────────────
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
// Prototype v17 lead stages: New · Contacted · Qualified · Proposal Pending · Nurturing · Converted · Disqualified.
// Stored statuses that keep their legacy name are shown under the prototype label.
const STAGE_LABEL: Record<string, string> = { Assigned: 'New', 'Opportunity Created': 'Converted', Lost: 'Disqualified' }
export const stageLabel = (s: string | null | undefined) => STAGE_LABEL[String(s || '')] || String(s || '')
/** Open (still being worked) statuses – the ones a lead can be converted from and whose follow-ups fall due. */
export const OPEN_STAGES = ['Assigned', 'Contacted', 'Qualified', 'Proposal Pending', 'Nurturing']
export const isOpen = (s: string | null | undefined) => OPEN_STAGES.includes(String(s || ''))
export const stageOf = (stages: Stage[], status: string | null | undefined) => stages.find(x => (x.values || [x.key]).includes(String(status || '')))
/** prototype pc() tone of the shown stage label */
export const stageTone = (s: string) => ({ Qualified: 'ok', Converted: 'ok' } as Record<string, string>)[stageLabel(s)] || 'inf'
