// Document Hub (prototype v17 + current options) – /api/v1/dochub for listing / upload / versions / tags / folders,
// /api/v1/document-management for move · trash · restore · star · share · approval · delete.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const size = (kb: number) => (kb >= 1000 ? `${(kb / 1000).toFixed(1)} MB` : `${kb} KB`)

export interface Meta { views: { k: string; l: string; n: number }[]; folders: { id: number; name: string; shared: boolean; n: number; mine: boolean }[]; sources: { k: string; l: string }[]; can_create: boolean; storage_kb: number }
export interface Doc {
  id: string; rid: number | null; name: string; ext: string; folder: string; folder_id: number | null; tags: string[]; link: string; link_source: string; link_id: number | null
  size_kb: number; ver: number; version_of: number | null; owner: string; owner_id: number | null; updated: string | null; status: string; url: string | null
  is_starred: boolean; is_shared: boolean; is_mine: boolean; deleted_at: string | null; source: string; can_submit: boolean; can_approve: boolean; can_trash: boolean; doc_type: string
}
export interface Version { rid: number; ver: number; by: string; d: string | null; url: string; size_kb: number; current: boolean; deleted: boolean }
export interface Query { view: string; folder_id: number | null; source: string; q: string; tag: string; offset: number; limit: number }

export const dochubApi = {
  meta: () => api.get<Meta>('/dochub/meta').then(r => r.data),
  query: (q: Query) => api.post<{ items: Doc[]; total: number }>('/dochub/query', q).then(r => r.data),
  upload: (fd: FormData) => api.post<{ id: number; document_id: string; version: number }>('/dochub/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data),
  versions: (rid: number) => api.get<{ items: Version[] }>(`/dochub/${rid}/versions`).then(r => r.data.items),
  setTags: (rid: number, tags: string[]) => api.put<{ tags: string[] }>(`/dochub/${rid}/tags`, { tags }).then(r => r.data.tags),
  createFolder: (name: string, shared: boolean) => api.post<{ id: number }>('/dochub/folders', { name, shared }).then(r => r.data),
  renameFolder: (id: number, name: string) => api.put(`/dochub/folders/${id}`, { name, shared: false }),
  deleteFolder: (id: number) => api.delete(`/dochub/folders/${id}`),
  // current options (existing endpoints)
  move: (docId: string, folder_id: number | null) => api.post(`/document-management/${docId}/move`, { folder_id }),
  trash: (docId: string) => api.post(`/document-management/${docId}/trash`),
  restore: (docId: string) => api.post(`/document-management/${docId}/restore`),
  remove: (docId: string) => api.delete(`/document-management/${docId}`),
  star: (docId: string) => api.post('/document-management/star', { document_id: docId }),
  share: (docId: string, user_ids: number[]) => api.post('/document-management/share', { document_id: docId, user_ids }),
  shares: (docId: string) => api.get<{ users?: { id: number; name: string }[]; shared_with?: number[] }>('/document-management/shares', { params: { document_id: docId } }).then(r => r.data),
  submit: (docId: string) => api.post(`/document-management/${docId}/submit-approval`),
  approve: (docId: string, comment: string) => api.post(`/document-management/${docId}/approve`, { comment }),
  reject: (docId: string, comment: string) => api.post(`/document-management/${docId}/reject`, { comment }),
  people: () => api.get<{ colleagues: { id: number; name: string; email: string }[] }>('/inbox/people').then(r => r.data.colleagues),
  linkOptions: () => api.get<any>('/document-management/link-options').then(r => r.data),
}
