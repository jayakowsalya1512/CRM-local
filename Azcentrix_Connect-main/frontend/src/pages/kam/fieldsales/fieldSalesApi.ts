// Field Sales 360 (prototype v17 · Finance & Field → Field Sales 360) – /api/v1/field-sales
import api from '@/services/api'

export const TYPES = ['Site Visit', 'Call', 'Meeting', 'Email', 'Demo', 'Follow-up'] as const
export const OUTCOMES = ['Positive', 'Neutral', 'Negative', 'Follow-up'] as const
export const KT = ['Team overview', 'Commitments', 'KAM 360', 'Visits & check-ins', 'Customer coverage', 'Activity analytics', 'Targets', 'Territories'] as const
export type Tab = typeof KT[number]

export interface Kam { id: number; name: string; role: string; designation: string; department: string; region: string; branch: string; manager: string; active: boolean }
export interface Meta {
  me: { id: number; name: string }; kams: Kam[]; fy: { label: string; start: string; end: string; elapsed_pct: number }
  policy: { A: number; B: number; C: number }; types: string[]; outcomes: string[]; can: { create: boolean; update: boolean; export: boolean }
}
export interface KamStat { id: number; name: string; target: number; target_source: string; won: number; attain: number | null; pipe: number; acts: number; visits: number; wr: number | null; accts: number }
export interface MapPt { l: string; la: number; lo: number; n: number; gps: number; src: 'gps' | 'city' }
export interface Team {
  fy: string; kpis: { target: number; won: number; attain: number | null; pipe: number; acts: number; spark: number[]; visits: number; covered: number; customers: number }
  map: MapPt[]; scoreboard: KamStat[]; days: string[]; heat: number[][]
}
export interface Step { k: string; label: string; done: boolean; stage: string | null }
export interface Kam360 {
  kam: { id: number; name: string }; stats: KamStat; spark: number[]; journey: { l: string; v: number }[]; by_type: { l: string; v: number }[]
  days: string[]; daily: number[]
  customers: { id: number; name: string; tier: string; revenue: number; health: number; last_visit: string | null }[]
  deals: { id: number; name: string; value: number; stage: string; jid: string; journey: { id: string; steps: Step[] } }[]
  log: { id: number; date: string; time: string | null; type: string; customer: string; customer_id: number | null; notes: string; outcome: string | null }[]
}
export interface VisitRow { id: number; date: string; check_in: string | null; kam: string; kam_id: number; customer: string; customer_id: number | null; location: string; duration: number | null; gps: string | null; notes: string; outcome: string | null; status: string; mine: boolean }
export interface Visits {
  kpis: { visits: number; verified: number; verified_pct: number | null; avg_min: number | null; timed: number; distance: number | null; unplanned: number }
  map: MapPt[]; per_kam: { l: string; v: number }[]; log: VisitRow[]
}
export interface Coverage {
  policy: { A: number; B: number; C: number }; kpis: { customers: number; ok: number; overdue: number; never: number; coverage: number | null }
  by_tier: { l: string; v: number }[]; by_kam: { l: string; v: number }[]
  overdue: { id: number; name: string; tier: string; kam: string; days: number | null; need: number; revenue: number }[]
}
export interface Analytics {
  kpis: { acts: number; positive: number | null; per_kam_day: number | null; followups: number; ratio: number | null; visits: number; calls: number }
  by_type: { l: string; v: number }[]; outcome: { l: string; v: number }[]; unclassified: number; days: string[]; daily: number[]
  productivity: ({ id: number; name: string; positive: number } & Record<string, number | string>)[]
}
export interface TargetRow { id: number; name: string; target: number; source: string; won: number; attain: number | null; gap: number; runrate: number | null; can_edit: boolean; updated_by: string | null; updated_at: string | null }
export interface Targets { fy: string; elapsed_pct: number; rows: TargetRow[] }
export interface Territories { states: string[]; kams: string[]; heat: number[][]; revenue: { l: string; v: number }[]; per_kam: { l: string; v: number }[] }
export interface Snapshot { name: string; health: number; tier: string; city: string; kam: string; kam_id: number | null; open_pipe: number; live_bids: number; outstanding: number; last_touch: number | null; recent: { type: string; date: string; note: string }[] }
export interface FormMeta {
  customers: { id: number; name: string }[]; kams: Kam[]; me: number; contacts: { id: number; name: string }[]
  links: { k: 'lead' | 'tender'; id: number; l: string }[]; snapshot: Snapshot | null; competitors: string[]; users: { id: number; name: string }[]
}
export type Gps = { lat: number; lng: number; accuracy: number | null }
export interface ActivityIn {
  action: 'log' | 'check_in' | 'plan'; type: string; customer_id: number; kam_id?: number | null; contact_id?: number | null
  link_kind?: 'lead' | 'tender' | null; link_id?: number | null; date: string; time?: string | null; duration?: number | null; where?: string | null
  notes?: string; topics?: string[]; competitor?: string | null; attendees?: string[]; outcome?: string | null; sentiment?: number | null
  gps?: Gps | null; gps_permission?: string | null; next_title?: string | null; next_due?: string | null
  expense?: number | null; expense_category?: string | null; distance_km?: number | null
}

const g = <T,>(u: string, params?: object) => api.get<T>(`/field-sales${u}`, { params }).then(r => r.data)
export const fsApi = {
  meta: () => g<Meta>('/meta'),
  team: () => g<Team>('/team'),
  kam: (id: number) => g<Kam360>(`/kams/${id}`),
  visits: () => g<Visits>('/visits'),
  coverage: () => g<Coverage>('/coverage'),
  analytics: () => g<Analytics>('/analytics'),
  targets: () => g<Targets>('/targets'),
  setTarget: (id: number, lakh: number) => api.put<TargetRow>(`/field-sales/targets/${id}`, { annual_target_lakh: lakh }).then(r => r.data),
  territories: () => g<Territories>('/territories'),
  formMeta: (customerId?: number | null) => g<FormMeta>('/form-meta', customerId ? { customer_id: customerId } : undefined),
  log: (body: ActivityIn) => api.post<{ id: number; status: string; followup_task: boolean; gps: string | null }>('/field-sales/activities', body).then(r => r.data),
  checkIn: (id: number, gps: Gps | null, perm: string | null) => api.post(`/field-sales/visits/${id}/check-in`, { gps, gps_permission: perm }).then(r => r.data),
  checkOut: (id: number, body: { outcome: string; notes?: string; distance_km?: number | null; gps: Gps | null; gps_permission: string | null }) =>
    api.post<{ duration: number }>(`/field-sales/visits/${id}/check-out`, body).then(r => r.data),
}

/** Browser location for a check-in – asked only when the user presses the button; never tracked in the background. */
export const captureGps = (): Promise<{ gps: Gps | null; perm: 'granted' | 'denied' | 'unavailable' }> => new Promise(res => {
  if (!('geolocation' in navigator)) return res({ gps: null, perm: 'unavailable' })
  navigator.geolocation.getCurrentPosition(
    p => res({ gps: { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? null }, perm: 'granted' }),
    e => res({ gps: null, perm: e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable' }),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })
})

export const first = (n: string) => (n || '').split(' ')[0]
/** Prototype charts label KAMs by first name; fall back to the full name where two KAMs share a first name. */
export const shortNames = (ns: string[]) => { const c: Record<string, number> = {}; ns.forEach(n => { c[first(n)] = (c[first(n)] || 0) + 1 }); return ns.map(n => c[first(n)] > 1 ? n : first(n)) }
export const short = <T extends { l: string }>(rows: T[]) => { const s = shortNames(rows.map(r => r.l)); return rows.map((r, i) => ({ ...r, l: s[i] })) }
