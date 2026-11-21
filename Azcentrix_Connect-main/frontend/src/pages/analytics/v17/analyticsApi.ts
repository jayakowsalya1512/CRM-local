// Analytics (prototype v17 · Intelligence → Analytics) – /api/v1/analytics-v17
import api from '@/services/api'

export const ANT = ['Executive', 'Sales funnel & journeys', 'Pipeline health', 'Win / loss & competitors', 'Customers', 'Bids & OEM',
  'Revenue & collections', 'People & productivity', 'Geography'] as const
export type Tab = typeof ANT[number]

export interface Meta { tabs: string[]; fys: { v: string; l: string; start: string; end: string }[]; company: string; can: { share: boolean } }
export interface Kpi { l: string; v: number | string | null; f: string; dc?: string }
export interface Col { k: string; t: string; f: string; w?: number; r?: boolean }
export interface Chart {
  t: string; type: 'hbars' | 'bars' | 'donut' | 'funnel' | 'line' | 'table'; d: { l: string; v: number | null; c?: string; n?: number }[]; f: string
  lw?: number; vw?: number; h?: number; note?: string; labels?: string[]; ser?: { n: string; c: number; v: (number | null)[] }[]
  cols?: Col[]; rows?: Record<string, any>[]
}
export interface Heat { t: string; rows: string[]; cols: string[]; v: number[][]; raw?: number[][]; fmt?: string }
export interface TabData {
  tab: string; fy: number; fy_label: string; start: string; end: string; company: string; generated: string
  k: Kpi[]; c: Chart[]; c2?: Chart[]; layout: number[]; table?: { t: string; cols: Col[]; rows: Record<string, any>[] }; heat?: Heat
  notes?: Record<string, string>; na?: string
}

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d.length) return d.map((x: any) => x?.msg || String(x)).join('; ')
  return e?.message && !/status code/i.test(e.message) ? e.message : fallback
}
const B = '/analytics-v17'
export const anApi = {
  meta: () => api.get<Meta>(`${B}/meta`).then(r => r.data),
  tab: (tab: string, fy: string) => api.get<TabData>(`${B}/tabs/${encodeURIComponent(tab)}`, { params: { fy } }).then(r => r.data),
  share: (tab: string, fy: string) => api.post<{ attachment: { key: string; name: string }; subject: string; body: string }>(`${B}/share`, { tab, fy }).then(r => r.data),
}

export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, '')} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, '')} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = String(d).slice(0, 10).split('-'); return y && m && dd ? `${dd} ${MON[Number(m) - 1]} ${y}` : String(d) }
export const kpiText = (k: Kpi) => k.v == null || k.v === '' ? '—' : k.f === 'inr' ? inr(Number(k.v)) : k.f === 'inr_day' ? `${inr(Number(k.v))} / day`
  : k.f === 'pct' ? `${k.v}%` : k.f === 'num' ? Number(k.v).toFixed(1) : typeof k.v === 'number' ? k.v.toLocaleString('en-IN') : String(k.v)
export const fmtOf = (f: string) => (v: number) => f === 'inr' ? inr(v) : f === 'pct' ? `${v}%` : f === 'days' ? `${v} d` : f === 'pts' ? `${v} pts` : String(Math.round(v * 10) / 10)
