// Masters (prototype v17 R.masters) – typed calls to /api/v1/masters360.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

export interface MasterItem { key: string; name: string; std: boolean; kind: string; parent_key: string | null; n: number; forms: number }
export interface Tree { company: string; masters: MasterItem[]; screens: { key: string; name: string }[]; kinds: string[]; modules: { k: string; l: string }[]; custom: number; can_manage: boolean }
export interface MasterDef { key: string; name: string; std: boolean; kind: string; parent_key: string | null; attrs: string[]; desc: string; use: string; order: boolean; id?: number }
export interface Value { id: number; v: string; attrs: Record<string, string>; parent_id: number | null; parent: string; on: boolean; pos: number; used: number }
export interface MasterPage { def: MasterDef; items: Value[]; total: number; parents: { id: number; v: string }[]; forms: { k: string; m: string; f: string }[]; offset: number; limit: number }

export const mastersApi = {
  tree: () => api.get<Tree>('/masters360/tree').then(r => r.data),
  master: (key: string, p: { q?: string; offset?: number; limit?: number }) => api.get<MasterPage>(`/masters360/${encodeURIComponent(key)}`, { params: p }).then(r => r.data),
  create: (d: { name: string; description: string; kind: string; parent_key: string | null; values: string[]; add_to: string | null }) => api.post<{ key: string }>('/masters360', d).then(r => r.data),
  rename: (key: string, d: { name: string; description?: string }) => api.put(`/masters360/${encodeURIComponent(key)}`, d),
  remove: (key: string) => api.delete(`/masters360/${encodeURIComponent(key)}`),
  addValue: (key: string, d: { v: string; attrs: Record<string, string>; parent_id: number | null }) => api.post<{ id: number }>(`/masters360/${encodeURIComponent(key)}/values`, d).then(r => r.data),
  updateValue: (key: string, id: number, d: { v?: string; attrs?: Record<string, string>; parent_id?: number | null; on?: boolean }) => api.put(`/masters360/${encodeURIComponent(key)}/values/${id}`, d),
  deleteValue: (key: string, id: number) => api.delete(`/masters360/${encodeURIComponent(key)}/values/${id}`),
  move: (key: string, id: number, dir: 1 | -1) => api.post(`/masters360/${encodeURIComponent(key)}/values/${id}/move`, { dir }),
  importValues: (key: string, values: string[], parent_id: number | null) => api.post<{ added: number }>(`/masters360/${encodeURIComponent(key)}/import`, { values, parent_id }).then(r => r.data),
  addToForm: (key: string, module: string, label: string) => api.post<{ id: number }>(`/masters360/${encodeURIComponent(key)}/add-to-form`, { module, label }).then(r => r.data),
}
