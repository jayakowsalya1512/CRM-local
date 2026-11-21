// Application settings (prototype v17 "p25" Settings page) – typed calls to /api/v1/app-settings.
import api from '@/services/api'

export type FieldType = 'text' | 'number' | 'time' | 'textarea' | 'select' | 'switch' | 'color' | 'file' | 'chips' | 'list'
export interface Field { k: string; l: string; t: FieldType; d: unknown; o?: string[]; h?: string }
export interface Category {
  id: string; n: string; i: string; d: string; g: [string, Field[]][]
  matrix?: boolean; series?: boolean; billing?: boolean; devices?: boolean; history?: boolean
}
export type Matrix = boolean[][]
export interface SeriesRow { r: string; p: string; s: string; d: number; n: number; y: boolean }
export type Values = Record<string, Record<string, unknown>>
export interface Payload {
  tenant: { name: string; slug: string }
  categories: Category[]
  values: Values
  customised: Record<string, string[]>
  matrix: { events: string[]; channels: string[] }
  can_manage: boolean
}
export interface Change { id: number; t: string | null; u: string; s: string; c: string; o: string; n: string; cat: string; k: string }
export interface SaveOut { category: string; key: string; value: unknown; label: string; change: Change; url?: string }
export interface Device { id: number; who: string; model: string; ip: string; last: string | null }
export interface Billing {
  plan: { name: string; status: string; renews: string | null; cycle: string } | null
  seats: { used: number; total: number }
  usage: { n: string; u: number; m: number; x: string }[]
  invoices: { id: number; n: string; p: string; a: number; s: string; link: string }[]
  payment: { method: string; ref: string; on: string } | null
}

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const fdt = (d: string | null | undefined) => { if (!d) return '—'; const t = d.slice(11, 16); return `${fd(d)}${t ? ' ' + t : ''}` }
export const inr = (v: number) => '₹' + Math.round(v).toLocaleString('en-IN')
export const pct = (u: number, m: number) => (m > 0 ? Math.min(100, Math.round((u / m) * 100)) : 0)

export const appSettingsApi = {
  load: () => api.get<Payload>('/app-settings/').then(r => r.data),
  save: (cat: string, key: string, value: unknown) => api.patch<SaveOut>(`/app-settings/${cat}/${key}`, { value }).then(r => r.data),
  reset: (cat: string) => api.post<{ category: string; removed: number }>(`/app-settings/${cat}/reset`).then(r => r.data),
  history: (offset = 0, limit = 40) => api.get<{ items: Change[]; total: number }>('/app-settings/history', { params: { offset, limit } }).then(r => r.data),
  billing: () => api.get<Billing>('/app-settings/billing').then(r => r.data),
  devices: () => api.get<{ items: Device[] }>('/app-settings/devices').then(r => r.data.items),
  revoke: (id: number) => api.delete(`/app-settings/devices/${id}`),
  upload: (kind: 'logo' | 'fav', file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return api.post<SaveOut>(`/app-settings/branding/${kind}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
}
