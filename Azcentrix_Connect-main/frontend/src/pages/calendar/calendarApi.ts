// Calendar & Tasks – typed calls to /api/v1/calendar.
import api from '@/services/api'

export type TaskStatus = 'To do' | 'In progress' | 'Done'
export type Priority = 'High' | 'Medium' | 'Low'
export const STATUSES: TaskStatus[] = ['To do', 'In progress', 'Done']
export const PRIORITIES: Priority[] = ['High', 'Medium', 'Low']

export interface CalEvent { key: string; date: string; type: string; title: string; module: string; id: number; route: string | null; sub: string }
export interface Task {
  id: number; title: string; related: string; related_module: string | null; related_id: number | null; related_route: string | null
  assignee_id: number | null; assignee: string; priority: Priority; due: string | null; status: TaskStatus
  created_by: string; created_by_id: number | null; created_at: string | null; updated_at: string | null; completed_at: string | null
  source: string | null; can_edit: boolean; can_delete: boolean
}
export interface Related { module: string; id: number; ref: string; type: string; title: string; customer: string | null; route: string; label: string }
export interface SyncStatus {
  provider: 'google'; configured: boolean; connected: boolean; status: 'not_configured' | 'not_connected' | 'connected' | 'auth_failed' | 'error'
  account: string | null; last_sync_at: string | null; last_status: 'ok' | 'partial' | 'failed' | 'auth_failed' | null; last_message: string | null
  counts: Record<string, number>
}
export interface Meta {
  event_types: { key: string; label: string }[]; statuses: TaskStatus[]; priorities: Priority[]; today: string
  people: { id: number; name: string }[]; me: { id: number; name: string }
  can: { create: boolean; update: boolean; delete: boolean }; sync: SyncStatus
}
export interface TaskInput { title: string; due: string; priority: Priority; status: TaskStatus; assignee_id: number | null; related_module: string | null; related_id: number | null }
export interface ListParams { q?: string; f?: Record<string, string>; adv?: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts?: [string, number][]; offset: number; limit: number }
export type SyncResult =
  | { status: 'needs_auth'; auth_url: string; message: string; sync?: SyncStatus }
  | { status: 'ok' | 'partial'; counts: Record<string, number>; errors: string[]; events: number; sync: SyncStatus }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

export const calApi = {
  meta: () => api.get<Meta>('/calendar/meta').then(r => r.data),
  events: (start: string, end: string) => api.get<{ items: CalEvent[] }>('/calendar/events', { params: { start, end } }).then(r => r.data.items),
  board: () => api.get<{ columns: { status: TaskStatus; count: number; items: Task[] }[]; limit: number }>('/calendar/tasks/board').then(r => r.data),
  list: (p: ListParams) => api.get<{ items: Task[]; total: number; total_all: number }>('/calendar/tasks', {
    params: {
      q: p.q || '', offset: p.offset, limit: p.limit,
      f: p.f && Object.values(p.f).some(Boolean) ? JSON.stringify(p.f) : '',
      adv: p.adv?.conds.length ? JSON.stringify(p.adv) : '',
      sorts: p.sorts?.length ? JSON.stringify(p.sorts) : '',
    },
  }).then(r => r.data),
  get: (id: number) => api.get<Task>(`/calendar/tasks/${id}`).then(r => r.data),
  create: (body: TaskInput) => api.post<Task>('/calendar/tasks', body).then(r => r.data),
  update: (id: number, body: TaskInput) => api.put<Task>(`/calendar/tasks/${id}`, body).then(r => r.data),
  status: (id: number, status: TaskStatus) => api.patch<Task>(`/calendar/tasks/${id}/status`, { status }).then(r => r.data),
  remove: (id: number) => api.delete<{ ok: boolean }>(`/calendar/tasks/${id}`).then(r => r.data),
  bulk: (ids: number[], action: 'status' | 'delete', status?: TaskStatus) => api.post<{ done: number; skipped: number }>('/calendar/tasks/bulk', { ids, action, status }).then(r => r.data),
  related: (q: string) => api.get<{ items: Related[] }>('/calendar/related', { params: { q } }).then(r => r.data.items),
  sync: () => api.post<SyncResult>('/calendar/sync', { return_origin: window.location.origin }).then(r => r.data),
  syncStatus: () => api.get<SyncStatus>('/calendar/sync/status').then(r => r.data),
  disconnect: () => api.delete('/calendar/sync/google').then(r => r.data),
}

// ─── prototype formatting helpers ─────────────────────────────────────────────
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** prototype fd(): "12 Nov 2026" */
export const fd = (d: string | null) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
/** prototype dto(): whole days from today */
export const dto = (d: string, today: string) => Math.round((new Date(`${d.slice(0, 10)}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 864e5)
/** prototype pc(): pill tone for a value (anything not listed is 'inf', e.g. To do / In progress) */
export const pc = (s: string) => ({ High: 'ba', Medium: 'wa', Low: 'mu', Done: 'ok' } as Record<string, string>)[s] || 'inf'
export const ago = (isoTs: string | null) => {
  if (!isoTs) return ''
  const s = Math.max(0, (Date.now() - new Date(isoTs).getTime()) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
