// Users & Teams / Roles & Security (prototype v17) – typed calls to /api/v1/admin360 (+ the existing /auth/users, /roles).
import api, { authApi } from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const fdt = (d: string | null | undefined) => { if (!d) return '—'; const t = d.slice(11, 16); return `${fd(d)}${t ? ' ' + t : ''}` }

// ── Users ──
export interface UsersMeta { company: string; views: string[]; roles: { name: string; label: string }[]; me: { id: number; name: string }; can: { manage: boolean } }
export interface UserRow {
  id: number; name: string; email: string; username: string; role: string; role_label: string; dept: string; designation: string; mgr: string
  mfa: boolean; last: string | null; status: 'Active' | 'Invited' | 'Inactive'; is_active: boolean; created: string | null
}
export interface UsersQuery { view: string; role: string; q: string; f: Record<string, string>; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] }; sorts: [string, number][]; offset: number; limit: number }
export interface UserNote { id: number; t: string; by: string; d: string | null }
export interface UserDetail extends UserRow { phone: string; branch: string; employee_code: string; activity: { t: string; by: string; d: string | null }[]; notes: UserNote[]; logins: { t: string | null; ip: string; d: string; r: string }[]; can: { manage: boolean } }
export interface UsersPage { items: UserRow[]; total: number; total_all: number; counts: Record<string, number> }
export interface Team { id: number; n: string; l: string; lead_id: number | null; m: number; d: string }
export interface Territory { id: number; t: string; states: string[]; s: string; rule: string; o: string; owner_id: number | null; a: number }
export interface LoginRow { id: number; u: string; t: string | null; ip: string; d: string; r: 'Success' | 'Failed'; reason: string }

// ── Roles ──
export interface MatrixPerm { id: number; key: string; d: string; a?: string }
export interface MatrixModule { key: string; label: string; section: string | null; acts: Record<string, MatrixPerm>; more: MatrixPerm[] }
export interface MatrixRole { id: number; name: string; label: string; users: number; is_system: boolean; is_active: boolean; level: number; scope: string }
export interface Matrix { acts: { l: string; a: string }[]; scopes: { l: string; v: string }[]; roles: MatrixRole[]; modules: MatrixModule[]; grants: Record<string, number[]>; can: { manage: boolean } }
export interface SharingRule { id: number; o: string; r: string; w: string; a: string; type: string; ref: string }
export interface FieldSecurity { module: string; label: string; modules: { k: string; l: string }[]; fields: { k: string; l: string; custom: boolean }[]; roles: { id: number; label: string; name: string }[]; levels: string[]; cells: Record<string, Record<string, string>> }

export const admin360Api = {
  usersMeta: () => api.get<UsersMeta>('/admin360/users/meta').then(r => r.data),
  users: (q: UsersQuery) => api.post<UsersPage>('/admin360/users/query', q).then(r => r.data),
  user: (id: number) => api.get<UserDetail>(`/admin360/users/${id}`).then(r => r.data),
  addUserNote: (id: number, text: string) => api.post<UserNote>(`/admin360/users/${id}/notes`, { text }).then(r => r.data),
  setActive: (id: number, active: boolean) => api.put(`/auth/users/${id}`, { is_active: active }),
  sendResetLink: (id: number) => api.post(`/auth/users/${id}/send-reset-link`),
  logoutUsers: (ids: number[]) => authApi.logoutSelectedUsers(ids),
  teams: () => api.get<{ items: Team[] }>('/admin360/teams').then(r => r.data.items),
  createTeam: (d: { name: string; manager_id: number | null; description: string }) => api.post('/admin360/teams', d).then(r => r.data),
  territories: () => api.get<{ items: Territory[] }>('/admin360/territories').then(r => r.data.items),
  saveTerritory: (d: { name: string; states: string[]; rule: string; owner_id: number | null }, id?: number) =>
    (id ? api.put(`/admin360/territories/${id}`, d) : api.post('/admin360/territories', d)).then(r => r.data),
  deleteTerritory: (id: number) => api.delete(`/admin360/territories/${id}`),
  loginHistory: (p: { q?: string; result?: string; offset: number; limit: number }) => api.get<{ items: LoginRow[]; total: number }>('/admin360/login-history', { params: p }).then(r => r.data),
  states: () => api.get<{ id: number; name: string }[]>('/masters/states').then(r => (Array.isArray(r.data) ? r.data : [])),

  matrix: () => api.get<Matrix>('/admin360/roles/matrix').then(r => r.data),
  setPermissions: (roleId: number, permission_ids: number[], module_scopes: { module: string; data_scope: string }[]) =>
    api.put(`/roles/${roleId}/permissions`, { permission_ids, module_scopes }).then(r => r.data),
  createRole: (d: { name: string; display_name: string; level?: number; description?: string }) => api.post<{ id: number }>('/roles', d).then(r => r.data),
  sharingRules: () => api.get<{ items: SharingRule[]; objects: string[] }>('/admin360/sharing-rules').then(r => r.data),
  saveSharingRule: (d: { object: string; rule: string; shared_with_type: string; shared_with_ref: string; access: string }, id?: number) =>
    (id ? api.put(`/admin360/sharing-rules/${id}`, d) : api.post('/admin360/sharing-rules', d)).then(r => r.data),
  deleteSharingRule: (id: number) => api.delete(`/admin360/sharing-rules/${id}`),
  fieldSecurity: (module: string) => api.get<FieldSecurity>('/admin360/field-security', { params: { module } }).then(r => r.data),
  setFieldSecurity: (d: { module: string; field_key: string; role_id: number; access: string }) => api.put('/admin360/field-security', d),
}
