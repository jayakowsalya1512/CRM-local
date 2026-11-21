import { useEffect, useState } from 'react'
import api from '@/services/api'

// Data access for the Prototype v9 dashboards. Every number comes from the tenant database through
// GET /dashboard/v9/{board} (KPIs and chart data), GET /dashboard/v9/records/{source} (paginated drill-down rows,
// built from the same filters as the KPIs) and GET /dashboard/v9/welcome. The server applies permissions and the
// role's Dashboard data visibility, and caches each board for 60 seconds.

export type Period = 'FY' | 'QTR' | 'MTD'
export const PERIODS: { v: Period; l: string }[] = [
  { v: 'FY', l: 'This FY' },
  { v: 'QTR', l: 'Last 90 days' },
  { v: 'MTD', l: 'Last 30 days' },
]

export type Res<T> = { data: T | null; loading: boolean; denied: boolean; error: string | null }

// Requests are shared by URL, so a board, its widgets and the welcome banner don't fetch the same data twice.
const cache = new Map<string, { at: number; p: Promise<any> }>()
const FRESH_MS = 60_000
export const clearDashCache = () => cache.clear()

function load(url: string) {
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.p
  const p = api.get(url).then(r => r.data)
  p.catch(() => cache.delete(url))
  cache.set(url, { at: Date.now(), p })
  return p
}

export function useDashFetch<T = any>(url: string | null, allowed = true, nonce = 0): Res<T> {
  const [res, setRes] = useState<Res<T>>({ data: null, loading: !!url && allowed, denied: !allowed, error: null })
  useEffect(() => {
    if (!url) { setRes({ data: null, loading: false, denied: false, error: null }); return }
    if (!allowed) { setRes({ data: null, loading: false, denied: true, error: null }); return }
    let live = true
    setRes(r => ({ ...r, loading: true, denied: false, error: null }))
    load(url).then(
      data => { if (live) setRes({ data, loading: false, denied: false, error: null }) },
      err => {
        if (!live) return
        const status = err?.response?.status
        setRes({ data: null, loading: false, denied: status === 403, error: status === 403 ? null : (err?.response?.data?.detail || 'Could not load dashboard data') })
      },
    )
    return () => { live = false }
  }, [url, allowed, nonce])
  return res
}

// Tab permissions (Roles & Permissions › Dashboard access).
export const PERM = {
  base: 'dashboard.view',
  leads: 'dashboard.leads.view',
  deals: 'dashboard.deals.view',
  tenders: 'dashboard.tenders.view',
  kam: 'dashboard.kam360.view',
  orders: 'dashboard.orders.view',
  finance: 'dashboard.finance.view',
  login: 'dashboard.login_tracker.view',
} as const

export type BoardKey = 'overview' | 'leads' | 'deals' | 'bids' | 'funnel' | 'kam' | 'orders' | 'finance' | 'login'
export const useBoard = <T = any>(board: BoardKey, period: Period, allowed: boolean, nonce = 0) =>
  useDashFetch<T>(`/dashboard/v9/${board}?period=${period}${nonce ? '&fresh=1' : ''}`, allowed, nonce)

export type Welcome = { bids_due: number; approvals: number; tasks_today: number; new_leads: number }
export const useWelcome = (nonce = 0) => useDashFetch<Welcome>('/dashboard/v9/welcome', true, nonce)

export type RecordPage = { rows: any[]; total: number; page: number; page_size: number; statuses: string[]; date_key: string | null }
export type RecordQuery = { filter: string; period: Period; q?: string; status?: string; date_from?: string; date_to?: string; sort?: string; dir?: 'asc' | 'desc'; page?: number; page_size?: number }
export const fetchRecords = (source: string, p: RecordQuery) =>
  api.get<RecordPage>(`/dashboard/v9/records/${source}`, { params: p }).then(r => r.data)

// Saved dashboards (MariaDB table dashboard_layouts in the tenant database).
export type LayoutWidget = { id: string; s: 1 | 2 | 3 }
export type Layout = { id: number; name: string; widgets: LayoutWidget[]; owner_id: number; owner?: string; mine: boolean; share: { scope: 'private' | 'users' | 'roles' | 'tenant'; user_ids: number[]; roles: string[] } }
export const layoutsApi = {
  list: () => api.get<Layout[]>('/dashboard/layouts').then(r => r.data),
  create: (name: string, widgets: LayoutWidget[]) => api.post<Layout>('/dashboard/layouts', { name, widgets }).then(r => r.data),
  update: (id: number, patch: { name?: string; widgets?: LayoutWidget[] }) => api.put<Layout>(`/dashboard/layouts/${id}`, patch).then(r => r.data),
  share: (id: number, share: Layout['share']) => api.put<Layout>(`/dashboard/layouts/${id}/share`, { scope: share.scope, user_ids: share.user_ids, roles: share.roles }).then(r => r.data),
  remove: (id: number) => api.delete(`/dashboard/layouts/${id}`),
}

export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)
export const daysFromToday = (d: string | null | undefined) => {
  if (!d) return null
  const t = new Date(); t.setHours(0, 0, 0, 0)
  const x = new Date(d); x.setHours(0, 0, 0, 0)
  return Math.round((x.getTime() - t.getTime()) / 864e5)
}
// Month keys matching the server's 6-month series (oldest first, local dates).
export const monthKeys = () => Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - (5 - i)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
