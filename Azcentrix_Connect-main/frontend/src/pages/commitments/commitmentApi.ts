// Commitments (prototype v18) – /api/v1/commitments. One dataset and one calculation service shared by
// Dashboard → Commitments and Field Sales 360 → Commitments (see backend/app/services/commitment_service.py).
import api from '@/services/api'
import { inr } from '@/pages/customers/customerApi'

export type TypeKey = 'lead' | 'deal' | 'quote' | 'bid' | 'order' | 'pay'
export interface CType { k: TypeKey; n: string; s: string; mod: string; ic: string; h: string; money?: boolean; flow?: boolean; on?: boolean; mod_label?: string }
export interface Settings { types: Partial<Record<TypeKey, boolean>>; cutoff: string; periods: string[]; roles: string[]; pay_tender: boolean; remind: boolean }
export interface Person { id: number; name: string; cat: string; head: boolean; team: string; team_id: number | null; target: number; members: string[] }
export interface Meta {
  me: { id: number; name: string }; today: string; week: string; fy_start_month: number; types: CType[]; settings: Settings; cutoffs: string[]
  periods: string[]; roles: string[]; flow: string; people: Person[]; teams: { id: number; name: string; lead: string }[]
  can: { submit: boolean; manage: boolean; settings: boolean; export: boolean; others: boolean }
  diag: { scope: string; visible: number; by_role: Record<string, number>; roles: string[]; my_role: string }
}

/** Why nobody can be picked to give a commitment – read from the caller's KAM visibility and the roles setting. */
export const noPeopleWhy = (m: Meta) => {
  const d = m.diag
  if (!d) return 'No one in your team gives commitments – check Settings → Who gives commitments'
  if (d.scope === 'none' || d.visible === 0) return `Your role (${d.my_role}) has no KAM data visibility, so you cannot see anyone. Set Roles & Security → ${d.my_role} → KAM → Data visibility to Team or All.`
  if (d.scope === 'own' && d.visible <= 1) return `Your role (${d.my_role}) has KAM data visibility “Own”, so you only see yourself – and ${d.my_role} does not give commitments. Set Roles & Security → ${d.my_role} → KAM → Data visibility to Team or All, or sign in as the KAM / Sales Head.`
  if (!d.roles.length) return 'Settings → Who gives commitments has no role ticked. Tick KAM and / or Sales Head.'
  const found = Object.entries(d.by_role).map(([k, v]) => `${v} ${k === 'other' ? 'other roles' : k}`).join(', ')
  return `None of the ${d.visible} people you can see has a role that gives commitments (${d.roles.join(', ')}). You can see: ${found}. Change Settings → Who gives commitments, or the users' roles.`
}
export interface Cell { cm: boolean; per?: string | null; cv: number; av: number; cvv: number; avv: number; pend: number; p: number | null }
export interface Row { id: number; n: string; team: string; tk: string; mgr: boolean; ty: Partial<Record<TypeKey, Cell>>; sub: boolean; score: number | null }
export interface Agg { tk: string; n: number; sub: number; ty: Partial<Record<TypeKey, Cell>>; score: number | null }
export type Tot = Partial<Record<TypeKey, { cv: number; av: number; cvv: number; avv: number; pend: number; p: number | null; n: number }>>
export interface Week { from: string; to: string; label: string; no: number; offset: number; day: number | null; pace: number | null; can_next: boolean; current: string }
export interface PayLine { id: string; cid: number; owner_id: number; owner: string; per: string; share: number; customer: string; customer_id: number | null; tender_id: number | null; tender: string | null; old_tender: string; wo_id: number | null; v: number; due: string | null; ack: number; pen: number; st: string }
export interface WeekView { week: Week; types: CType[]; rows: Row[]; tot: Tot; agg: Agg[]; teams: string[]; pay: PayLine[]; pay_total: number; missing: { id: number; n: string; tk: string }[]; cutoff: string }
export interface Dash {
  week: Week; types: CType[]; rows: Row[]; tot: Tot; agg: Agg[]; hist: { w: string; from: string; pay_cv: number; pay_av: number; score: number }[]
  heat: { id: number; n: string; v: (number | null)[] }[]; pay: PayLine[]; risk: { id: number; n: string; tk: string; score: number }[]
  submission: { cur: { no: number; sub: number; total: number }; next: { no: number; from: string; sub: number; total: number; missing: { id: number; n: string }[] } }
}
export interface CSummary { id: number; code: string; owner_id: number; owner: string; team: string; scope: string; per: string; from: string; to: string; label: string; entries: { k: TypeKey; n: number; v: number }[]; n_entries: number; pay: number; target: number; submitted: string | null; status: string; cover: boolean }
export interface PersonView { week: Week; types: CType[]; person: { id: number; name: string; team: string; head: boolean; target: number }; row: Row | null; hist: { w: string; score: number | null; pay_cv: number; pay_av: number }[]; commitments: CSummary[] }
export interface Report { types: CType[]; weeks: { w: string; from: string; label: string; short: string; rows: Row[]; agg: Agg[]; tot: Tot; overall: number }[] }
export interface Entry { type: TypeKey; n: number; value: number; customer_id: number | null; customer_name?: string; tender_id: number | null; old_tender: string; work_order_id: number | null; deal_id: number | null; source: string; expected_on: string | null; note: string }
export interface DEntry { id: number; n: number; v: number; customer: string; customer_id: number | null; tender_id: number | null; tender: string | null; old_tender: string; wo_id: number | null; deal_id: number | null; source: string; due: string | null; note: string; r: { ack?: number; pen?: number; p: number; st: string } | null }
export interface Detail {
  id: number; code: string; owner_id: number; owner: string; label: string; per: string; scope: string; team: string; status: string; from: string; to: string; days: number; elapsed: number; closed: boolean
  target: number; pay: number; submitted_at: string | null; submitted_by: string; acknowledged_by: string; acknowledged_at: string | null; edited_at: string | null; note: string; types: CType[]
  per_type: { k: TypeKey; cv: number; av: number; p: number; exp: number; pend: number; entries: DEntry[] }[]
  weeks: { from: string; label: string; cells: { k: TypeKey; cv: number; av: number; p: number; future: boolean }[] }[]
  can: { edit: boolean; ack: boolean; delete: boolean }; edit: { owner_id: number; per: string; anchor: string; note: string; entries: Entry[] }
}
export interface PeriodOpt { per: string; from: string; to: string; label: string; days: number; opt: string }
export interface FormMeta {
  owner: { id: number; name: string; head: boolean; team: string; teams: string[] }; target: number; customers: { id: number; name: string }[]
  deals: { id: number; name: string; value: number; customer_id: number | null; customer: string }[]; tenders: { id: number; ref: string; customer: string; value: number; submit: string | null }[]
  sources: string[]; existing: { id: number; code: string; per: string; from: string; scope: string }[]; periods: Record<string, PeriodOpt[]>; m0: number
}
export interface Refs { tenders: { tender_id: number; label: string; wo_id: number | null; value: number; next?: { balance: number; due: string | null } }[]; orders: { id: number; number: string; tender_id: number | null; next?: { balance: number; due: string | null } }[] }
export interface Body { owner_id: number; per: string; anchor: string; entries: Entry[]; note: string; replace?: boolean }

const B = '/commitments'
const g = <T,>(u: string, params?: object) => api.get<T>(`${B}${u}`, { params }).then(r => r.data)
export const cmApi = {
  meta: () => g<Meta>('/meta'),
  week: (week?: string, team?: string) => g<WeekView>('/week', { week, team: team && team !== 'All' ? team : undefined }),
  dashboard: (week?: string) => g<Dash>('/dashboard', { week }),
  person: (id: number, week?: string) => g<PersonView>(`/people/${id}`, { week }),
  report: (weeks: number) => g<Report>('/report', { weeks }),
  register: () => g<{ types: CType[]; rows: CSummary[] }>(''),
  detail: (id: number) => g<Detail>(`/${id}`),
  formMeta: (owner: number) => g<FormMeta>('/form-meta', { owner_id: owner }),
  period: (per: string, anchor: string) => g<PeriodOpt & { options: PeriodOpt[] }>('/period', { per, anchor }),
  refs: (customer: number) => g<Refs>(`/customer-refs/${customer}`),
  create: (b: Body) => api.post<{ id: number; code: string; label: string; updated: boolean }>(B, b).then(r => r.data),
  update: (id: number, b: Body) => api.put<{ id: number; code: string; label: string; updated: boolean }>(`${B}/${id}`, b).then(r => r.data),
  ack: (id: number) => api.post(`${B}/${id}/acknowledge`).then(r => r.data),
  remove: (id: number) => api.delete(`${B}/${id}`),
  remind: (user_ids: number[], week?: string) => api.post<{ sent: number; names: string[]; week: string }>(`${B}/remind`, { user_ids, week }).then(r => r.data),
  saveSettings: (s: Partial<Settings>) => api.put<Settings>(`${B}/settings`, s).then(r => r.data),
  addTeam: (name: string) => api.post<{ id: number; name: string }>(`${B}/teams`, { name }).then(r => r.data),
  setTeam: (uid: number, team_id: number | null) => api.put<{ user_id: number; team: string }>(`${B}/teams/members/${uid}`, { team_id }).then(r => r.data),
}

/** Backend error text – including the 409 duplicate-period detail object. */
export const errText = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && !Array.isArray(d) && d.message) return String(d.message)
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

// prototype helpers
export const pc3 = (p: number | null | undefined) => p == null ? 'var(--bw-ln)' : p >= 100 ? 'var(--bw-ok)' : p >= 75 ? 'var(--bw-in)' : p >= 45 ? 'var(--bw-wa)' : 'var(--bw-ba)'
export const pctOf = (a: number, b: number) => b ? Math.round(a / b * 100) : 0
export const lakh = (v: number) => Math.round((+v || 0) / 1e3) / 100
export const fmtN = (v: number) => { const r = Math.round((+v || 0) * 10) / 10; return r.toLocaleString('en-IN') }
export const cmFmt = (t: CType | undefined, v: number) => t?.money ? inr(v) : fmtN(v)
export const CMSC: Record<string, string> = { Achieved: 'ok', 'Partly achieved': 'wa', 'Awaiting finance': 'inf', Open: 'mu', Missed: 'ba' }
export const stTone = (s: string) => s === 'Acknowledged' ? 'ok' : s === 'Closed' ? 'mu' : 'wa'
export const addD = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
export const first = (n: string) => (n || '').split(' ')[0]
