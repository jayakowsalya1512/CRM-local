// Forecasts (prototype v17 · Sales → Forecasts) – /api/v1/forecasts
import api from '@/services/api'

export interface Period { key: string; label: string; full: string; kind: 'fy' | 'quarter' | 'month'; start: string; end: string }
export interface Kpis { quota: number; closed: number; closed_pct: number | null; commit: number; best_case: number; pipeline: number; adjustment: number; gap: number }
export interface RepRow {
  rep_id: number; name: string; active: boolean; quota: number; closed: number; commit: number; best_case: number; pipeline: number
  adjustment: number; attainment: number | null; editable: boolean
}
export interface Submission {
  id: number; period: string; period_label: string; version: number; status: 'pending' | 'approved' | 'rejected'; submitted_by: string | null
  submitted_at: string | null; approver: string | null; approval_request_id: number | null; decided_at: string | null; remarks: string | null
}
export interface Summary {
  period: Period; periods: Period[]; kpis: Kpis; rows: RepRow[]
  composition: { items: { l: 'Closed' | 'Commit' | 'Best case' | 'Pipeline'; v: number }[]; center: number | null }
  thresholds: { commit: number; best: number }; scope: 'all' | 'team' | 'own' | 'none'; deals: number; locked: boolean
  can: { adjust: boolean; submit: boolean; adjustments_enabled: boolean; configure: boolean }
  submission: Submission | null
}

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (d && typeof d === 'object' && typeof d.message === 'string') return d.message
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

const B = '/forecasts'
export const forecastApi = {
  summary: (period?: string) => api.get<Summary>(`${B}/summary`, { params: period ? { period } : {} }).then(r => r.data),
  adjust: (period: string, rep_id: number, amount: string) =>
    api.put<{ rep_id: number; old: number; amount: number; changed: boolean; summary: Summary }>(`${B}/adjustments`, { period, rep_id, amount }).then(r => r.data),
  submit: (period: string) => api.post<{ submission: Submission; message: string }>(`${B}/submit`, { period }).then(r => r.data),
}

// prototype inr(): ₹x.xx Cr / ₹x.x L / ₹n,nn,nnn
export const inr = (v: number | null | undefined) => {
  const n = Number(v || 0), a = Math.abs(n)
  if (a >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`
  if (a >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
