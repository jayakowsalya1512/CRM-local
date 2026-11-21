// Reports (prototype v17 · Intelligence → Reports) – /api/v1/report-catalogue
import api from '@/services/api'

export type Period = 'FY' | 'QTR' | 'MTD'
export interface Item { key: string; cat: string; n: string; d: string; custom: boolean; fav: boolean; schedule: string | null }
export interface Catalogue {
  company: string; ready_count: number; items: Item[]; categories: string[]; periods: { v: Period; l: string }[]
  frequencies: string[]; formats: string[]; me: { id: number; name: string; email: string }
  can: { export: boolean; schedule: boolean; share: boolean; build: boolean; docs: boolean }
}
export interface Kpi { l: string; v: number | string | null; f: string; dc?: string }
export interface Chart { t: string; type: 'hbars' | 'bars' | 'donut' | 'funnel' | 'line'; d: { l: string; v: number; c?: string }[]; f: string; lw?: number; vw?: number; h?: number }
export interface Col { k: string; t: string; f: string; w?: number; r?: boolean; sum?: boolean; money?: boolean }
export interface Schedule { id: number; frequency: string; format: string; period: Period; recipients: string[]; active: boolean; next_run: string | null; last_run: string | null; last_status: string | null; last_error: string | null }
export interface Report {
  key: string; cat: string; n: string; d: string; custom: boolean; generated: string; company: string; period: Period; period_label: string
  start: string; end: string; basis: string | null; note: string | null; k: Kpi[]; c: Chart[]; cols: Col[]; rows: Record<string, any>[]
  total: number; truncated: boolean; open: { module?: string; route?: string } | null; fav: boolean; schedule: Schedule | null
}
export interface Field { key: string; label: string; type: string; groupable: boolean; default: boolean; fmt: string }
export type Preview = { grouped: false; cols: { k: string; t: string; fmt: string }[]; rows: Record<string, any>[]; total: number }
  | { grouped: true; group_label: string; value_label: string | null; rows: { g: string; n: number; v: number }[]; total: number; capped: boolean }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d.length) return d.map((x: any) => x?.msg || String(x)).join('; ')
  return e?.message && !/status code/i.test(e.message) ? e.message : fallback
}
const B = '/report-catalogue'
const enc = encodeURIComponent
export const rpApi = {
  catalogue: () => api.get<Catalogue>(`${B}/catalogue`).then(r => r.data),
  fav: (key: string, on: boolean) => api.put(`${B}/favourites/${enc(key)}`, { on }).then(r => r.data),
  run: (key: string, period: Period) => api.get<Report>(`${B}/reports/${enc(key)}`, { params: { period } }).then(r => r.data),
  exportFile: async (key: string, period: Period, fmt: string) => {
    const r = await api.get(`${B}/reports/${enc(key)}/export`, { params: { period, fmt }, responseType: 'blob' })
    const cd = String(r.headers['content-disposition'] || '')
    const name = /filename="([^"]+)"/.exec(cd)?.[1] || `report.${fmt === 'Excel' ? 'xlsx' : fmt.toLowerCase()}`
    const url = URL.createObjectURL(r.data as Blob)
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return name
  },
  email: (key: string, period: Period, format: string) => api.post<{ attachment: { key: string; name: string }; subject: string; body: string; reference: string }>(
    `${B}/reports/${enc(key)}/email`, { period, format }).then(r => r.data),
  saveSchedule: (key: string, b: { frequency: string; format: string; recipients: string; period: Period }) => api.put<Schedule>(`${B}/reports/${enc(key)}/schedule`, b).then(r => r.data),
  removeSchedule: (key: string) => api.delete(`${B}/reports/${enc(key)}/schedule`).then(r => r.data),
  sources: () => api.get<{ items: { key: string; label: string }[] }>(`${B}/builder/sources`).then(r => r.data.items),
  fields: (source: string) => api.get<{ items: Field[] }>(`${B}/builder/fields`, { params: { source } }).then(r => r.data.items),
  preview: (b: { source: string; fields: string[]; group: string | null }) => api.post<Preview>(`${B}/builder/preview`, b).then(r => r.data),
  save: (b: { source: string; fields: string[]; group: string | null; name: string; description: string; visibility: string }) =>
    api.post<{ key: string; id: number; name: string }>(`${B}/builder/save`, b).then(r => r.data),
}

export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = String(d).slice(0, 10).split('-'); return y && m && dd ? `${dd} ${MON[Number(m) - 1]} ${y}` : String(d) }
export const kpiText = (k: Kpi) => k.v == null || k.v === '' ? '—' : k.f === 'inr' ? inr(Number(k.v)) : k.f === 'pct' ? `${k.v}%` : String(k.v)
export const chartFmt = (f: string) => (v: number) => f === 'inr' ? inr(v) : f === 'pct' ? `${v}%` : f === 'pts' ? `${v} pts` : String(Math.round(v * 10) / 10)
