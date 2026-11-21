// Customization Studio (prototype v17) – typed calls to /api/v1/studio.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }

export interface Opt { k: string; l: string }
export interface LayoutMeta { modules: Opt[]; types: Opt[]; masters: Opt[]; show_when: string[]; can_manage: boolean }
export interface LField {
  id: number | null; key: string; label: string; type: string; sys: boolean; req: boolean; w: 1 | 2; opts: string[]
  help: string; visible: boolean; master: string | null; show_when: string; sort: number
}
export interface Layout { module: string; label: string; fields: LField[] }
export interface Picklists { masters: Opt[]; used: { k: string; l: string; u: { module: string; field: string }[] }[] }
export interface CoField { id?: number; k: string; l: string; t: string; o: string[]; req: boolean }
export interface CustomObject { id: number; slug: string; n: string; p: string; icon: string; rows: number; f: CoField[] }
export type CustomRecord = { id: number; created: string | null; updated: string | null } & Record<string, unknown>
export interface Rule { id: number; n: string; o: string; f: string; m: string; on: boolean }

export const studioApi = {
  meta: () => api.get<LayoutMeta>('/studio/layout/meta').then(r => r.data),
  layout: (module: string) => api.get<Layout>(`/studio/layout/${module}`).then(r => r.data),
  saveLayout: (module: string, fields: LField[]) => api.put<Layout>(`/studio/layout/${module}`, { fields }).then(r => r.data),
  picklists: () => api.get<Picklists>('/studio/picklists').then(r => r.data),
  objects: () => api.get<{ items: CustomObject[] }>('/studio/objects').then(r => r.data.items),
  createObject: (d: { name: string; plural: string; fields: { l: string; t: string; o?: string[]; req?: boolean }[] }) => api.post<CustomObject>('/studio/objects', d).then(r => r.data),
  deleteObject: (id: number) => api.delete(`/studio/objects/${id}`),
  records: (id: number, q: { q: string; sorts: [string, number][]; offset: number; limit: number }) =>
    api.post<{ object: CustomObject; items: CustomRecord[]; total: number }>(`/studio/objects/${id}/records/query`, q).then(r => r.data),
  saveRecord: (id: number, data: Record<string, unknown>, rid?: number) =>
    (rid ? api.put(`/studio/objects/${id}/records/${rid}`, { data }) : api.post(`/studio/objects/${id}/records`, { data })).then(r => r.data as CustomRecord),
  deleteRecord: (id: number, rid: number) => api.delete(`/studio/objects/${id}/records/${rid}`),
  rules: () => api.get<{ items: Rule[]; objects: string[] }>('/studio/rules').then(r => r.data),
  saveRule: (d: { name: string; object: string; formula: string; message: string }, id?: number) =>
    (id ? api.put<Rule>(`/studio/rules/${id}`, d) : api.post<Rule>('/studio/rules', d)).then(r => r.data),
  toggleRule: (id: number, on: boolean) => api.patch<Rule>(`/studio/rules/${id}/toggle`, { on }).then(r => r.data),
  deleteRule: (id: number) => api.delete(`/studio/rules/${id}`),
}
