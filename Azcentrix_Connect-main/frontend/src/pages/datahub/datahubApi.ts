// Data Hub (prototype v17 R.datahub) – /api/v1/datahub plus the module import endpoints and /recycle-bin.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }

export interface Meta { tabs: string[]; import_objects: { k: string; l: string }[]; export_objects: { k: string; l: string }[]; mass_modules: { k: string; l: string }[]; can_manage: boolean }
export interface ImportCols { object: string; label: string; endpoint: string; columns: string[]; required: string[]; mode: 'csv' | 'values' }
export interface Job { id: number; kind: string; object: string | null; n: string; d: string | null; finished: string | null; st: string; s: string; rows: number; done: number; errors: number; by: string; file: string | null; can_download: boolean; can_undo: boolean; error: string | null }
export interface Migration { sources: { n: string; kind: 'file' | 'api'; info: string }[]; requests: { id: number; source: string; account: string; objects: { name: string; count?: number }[]; status: string; notes: string; by: string; d: string | null }[] }
export interface DupPair { id: string; a: { id: number; name: string; sub: string }; b: { id: number; name: string; sub: string }; sc: number; why: string }
export interface MassFields { module: string; label: string; fields: { k: string; l: string; kind: string; options?: { v: string | number; l: string }[] }[]; counts: { all: number; '30d': number } }
export interface BinItem { module_key: string; module_label: string; record_id: string; title: string; subtitle: string; deleted_at: string | null; deleted_by_name: string | null }

export const datahubApi = {
  meta: () => api.get<Meta>('/datahub/meta').then(r => r.data),
  importColumns: (obj: string) => api.get<ImportCols>('/datahub/import/columns', { params: { obj } }).then(r => r.data),
  runImport: (endpoint: string, csv: string, fileName: string) => {
    const fd = new FormData(); fd.append('file', new Blob([csv], { type: 'text/csv' }), fileName)
    return api.post<any>(endpoint, fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
  },
  importValues: (key: string, values: string[]) => api.post<{ added: number }>(`/masters360/${key}/import`, { values, parent_id: null }).then(r => r.data),
  logImport: (d: { object: string; file_name: string; rows_total: number; created: number; duplicates: number; errors: number; detail?: Record<string, unknown> }) => api.post('/datahub/import/log', d),
  migration: () => api.get<Migration>('/datahub/migration').then(r => r.data),
  requestMigration: (d: { source: string; config: Record<string, string>; objects: string[]; notes: string }) => api.post<{ id: number; status: string; account: string }>('/datahub/migration', d).then(r => r.data),
  duplicates: (obj: string) => api.get<{ items: DupPair[] }>('/datahub/duplicates', { params: { obj } }).then(r => r.data.items),
  merge: (object: string, keep_id: number, drop_id: number) => api.post('/datahub/duplicates/merge', { object, keep_id, drop_id }),
  ignore: (object: string, keep_id: number, drop_id: number) => api.post('/datahub/duplicates/ignore', { object, keep_id, drop_id }),
  massFields: (module: string) => api.get<MassFields>('/datahub/mass-update/fields', { params: { module } }).then(r => r.data),
  massUpdate: (d: { module: string; field: string; value: string | number; scope: string }) => api.post<{ updated: number; job_id: number }>('/datahub/mass-update', d).then(r => r.data),
  undo: (id: number) => api.post<{ restored: number }>(`/datahub/jobs/${id}/undo`).then(r => r.data),
  jobs: (kind: string, offset = 0, limit = 25) => api.get<{ items: Job[]; total: number }>('/datahub/jobs', { params: { kind, offset, limit } }).then(r => r.data),
  startExport: (object: string) => api.post<{ id: number }>('/datahub/exports', { object }).then(r => r.data),
  download: (id: number) => api.get(`/datahub/jobs/${id}/download`, { responseType: 'blob' }),
  bin: (p: { search?: string; module?: string; page: number; limit: number }) => api.get<{ items: BinItem[]; total: number; modules: { key: string; label: string }[] }>('/recycle-bin', { params: p }).then(r => r.data),
  binRestore: (module_key: string, record_id: string) => api.post(`/recycle-bin/${module_key}/${record_id}/restore`),
  binPurge: (module_key: string, record_id: string) => api.delete(`/recycle-bin/${module_key}/${record_id}`),
}
