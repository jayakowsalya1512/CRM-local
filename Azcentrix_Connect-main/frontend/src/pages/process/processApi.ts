// Process Designer (prototype v17) – typed calls to /api/v1/process.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
/** prototype inr(): ₹ in lakh / crore */
export const inr = (v: number) => {
  const a = Math.abs(v || 0)
  if (a >= 1e7) return `₹${+(v / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${+(v / 1e5).toFixed(2)} L`
  return `₹${Math.round(v || 0).toLocaleString('en-IN')}`
}

export type Kind = 'open' | 'won' | 'lost'
export type Gate = 'None' | 'Approval' | 'Checklist'
export interface Appr { chain: string[]; min: number; sla: number; auto: boolean }
export interface Stage {
  id: string; name: string; kind: Kind; sla: number; gate: Gate; owner_role: string; checklist: string[]
  exit: string; auto: string; forecast: string | null; appr: Appr | null; n: number; prob: number | null
}
export type Obj = 'leads' | 'opps' | 'tenders' | 'quotes' | 'wo'
export interface Flow {
  key: string; label: string; obj: Obj; fixed: boolean; stages: Stage[]
  name?: string; pipe_label?: string; dtype?: 'Tender' | 'Quotation'; creates?: string; auto?: boolean; biz?: string; default?: boolean
  template?: string | null; lifecycle?: boolean; id?: number; trigger?: string
}
export interface Conv {
  lead: { stage: string; auto: boolean; type: string; acct: boolean; to: string; map: Record<string, boolean> }
  quote: { auto: boolean }; tender: { auto: boolean }
}
export interface Overview {
  company: string; published: { version: number; at: string | null; by: string | null }
  names: Record<string, [string, string]>; objects: Record<string, boolean>; object_labels: [string, string][]
  conv: Conv; flows: Flow[]; roles: string[]; gates: Gate[]; forecasts: string[]; biz: string[]
  templates: { l: string; k: string }[]; lc_templates: string[]; records: Record<string, number>; can_manage: boolean
}
export interface Policy { p: string; s: string; c: string[]; w: number; l: number; k: string }

export const processApi = {
  overview: () => api.get<Overview>('/process/overview').then(r => r.data),
  saveFlow: (key: string, stages: Stage[]) => api.put(`/process/flows/${encodeURIComponent(key)}`, { stages }).then(r => r.data),
  createPipeline: (d: { name: string; copy_from: string; creates: string; biz: string; default: boolean }) => api.post<{ key: string }>('/process/pipelines', d).then(r => r.data),
  patchPipeline: (key: string, d: { name?: string; creates?: string; auto?: boolean; biz?: string; default?: boolean }) => api.put(`/process/pipelines/${encodeURIComponent(key)}`, d).then(r => r.data),
  deletePipeline: (key: string) => api.delete(`/process/pipelines/${encodeURIComponent(key)}`),
  createLifecycle: (d: { name: string; template: string; trigger: string }) => api.post<{ key: string }>('/process/lifecycles', d).then(r => r.data),
  deleteLifecycle: (key: string) => api.delete(`/process/lifecycles/${encodeURIComponent(key)}`),
  saveNames: (names: Record<string, [string, string]>) => api.put('/process/config/names', { names }).then(r => r.data),
  saveObjects: (objects: Record<string, boolean>) => api.put('/process/config/objects', { objects }).then(r => r.data),
  saveConv: (conv: Partial<Record<'lead' | 'quote' | 'tender', Record<string, unknown>>>) => api.put<{ conv: Conv }>('/process/config/conv', { conv }).then(r => r.data),
  applyTemplate: (key: string) => api.post<{ name: string; records_moved?: number }>('/process/template', { key }).then(r => r.data),
  publish: () => api.post<{ version: number }>('/process/publish').then(r => r.data),
  policies: () => api.get<{ items: Policy[] }>('/process/approval-policies').then(r => r.data),
}
