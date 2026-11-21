// Lead capture forms (prototype v17 · Sales → Capture Forms) – /api/v1/capture-forms
import api from '@/services/api'

export type FieldKey = 'name' | 'contact' | 'email' | 'phone' | 'interest' | 'value' | 'message' | 'tender' | 'state'
export interface Field { key: FieldKey; label: string; kind: 'text' | 'email' | 'tel' | 'product' | 'number' | 'textarea' | 'state' }
export interface RoutingGroup { group: string; items: { value: string; label: string; sub?: string; disabled?: boolean }[] }
export interface Meta {
  fields: Field[]; spam_modes: string[]; routing: RoutingGroup[]
  sources: { id: number; name: string; active: boolean }[]; products: { id: number; name: string }[]; states: { id: number; name: string }[]
  kpis: { forms: number; live: number; subs: number; leads: number; won: number; spam: number; spark: number[] }
  can: { create: boolean; update: boolean; leads: boolean }
  me: { id: number; name: string; email: string | null; phone: string | null }
}
export interface Form {
  id: number; key: string; name: string; on: boolean; fields: FieldKey[]; required: FieldKey[]; assign: string; assign_label: string
  source_id: number | null; source: string | null; thanks: string; spam: string; subs: number; leads: number; conv: number
  embed: { url: string; script: string; code: string }
}
export interface Sub {
  id: number; ref: string; received_at: string | null; test: boolean; status: 'lead_created' | 'duplicate' | 'error' | 'received'
  company: string | null; contact: string | null; interest: string | null; assigned_to: string | null; lead_id: number | null; lead_ref: string | null; error: string | null
}
export interface TestResult { ok: boolean; status: string; submission?: string; lead_id?: number; lead_ref?: string; assigned_to?: string | null; error?: string }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
export const fieldErrors = (e: any): Record<string, string> => {
  const d = e?.response?.data?.detail
  return d && typeof d === 'object' && !Array.isArray(d) && d.fields ? d.fields : {}
}

const B = '/capture-forms'
export const capApi = {
  meta: (formId?: number) => api.get<Meta>(`${B}/meta`, { params: formId ? { form_id: formId } : {} }).then(r => r.data),
  list: () => api.get<{ items: Form[] }>(B).then(r => r.data.items),
  create: () => api.post<Form>(B).then(r => r.data),
  update: (id: number, body: Partial<{ name: string; fields: FieldKey[]; required: FieldKey[]; assign: string; source_id: number | null; thanks: string; spam: string }>) =>
    api.put<Form>(`${B}/${id}`, body).then(r => r.data),
  publish: (id: number, on: boolean) => api.post<{ id: number; on: boolean }>(`${B}/${id}/publish`, { on }).then(r => r.data),
  submissions: (id: number) => api.get<{ items: Sub[] }>(`${B}/${id}/submissions`).then(r => r.data.items),
  challenge: (id: number) => api.get<{ rt: string; captcha: { question: string; token: string } | null }>(`${B}/${id}/challenge`).then(r => r.data),
  test: (id: number, body: { values: Record<string, string>; rt: string; hp: string; ct?: string | null; ca?: string }) =>
    api.post<TestResult>(`${B}/${id}/test`, body).then(r => r.data),
}

export const ago = (iso: string | null) => {
  if (!iso) return '—'
  const t = new Date(iso).getTime(), s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
