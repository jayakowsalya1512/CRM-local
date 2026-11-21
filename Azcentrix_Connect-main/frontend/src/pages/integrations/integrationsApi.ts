// Marketplace & API (prototype v17 R.integrations) – typed calls to /api/v1/integrations360.
import api from '@/services/api'

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fd = (d: string | null | undefined) => { if (!d) return '—'; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}` }
export const fdt = (d: string | null | undefined) => { if (!d) return '—'; const t = d.slice(11, 16); return `${fd(d)}${t ? ' ' + t : ''}` }
/** "2 min ago" / "1 h ago" / "3 d ago" */
export const ago = (d: string | null | undefined) => {
  if (!d) return '—'
  const ms = Date.now() - new Date(d.endsWith('Z') || /[+-]\d\d:\d\d$/.test(d) ? d : d + 'Z').getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export interface Integration { key: string; name: string; cat: string; desc: string; connected: boolean; sync: string; mapping: string; last_sync: string | null; has_secret: boolean; channel: string | null; developer: boolean }
export interface Marketplace { company: string; items: Integration[]; categories: string[]; connected: number; sync_options: string[]; can_manage: boolean }
export interface ApiKey { id: number; n: string; k: string; s: string; c: string | null; last: string | null; status: string }
export interface Webhook { id: number; e: string; events: string[]; u: string; s: 'Active' | 'Failed'; l: string | null; code?: number | null; err?: string | null }
export interface ConnectedApp { app_id: number; a: string; pub: string; u: string; s: string; d: string | null }

export const integrationsApi = {
  marketplace: () => api.get<Marketplace>('/integrations360/marketplace').then(r => r.data),
  connect: (key: string, d: { client_id: string; secret: string }) => api.post(`/integrations360/marketplace/${key}/connect`, d),
  configure: (key: string, sync: string) => api.put(`/integrations360/marketplace/${key}`, { sync }),
  disconnect: (key: string) => api.delete(`/integrations360/marketplace/${key}/connect`),
  apiKeys: () => api.get<{ items: ApiKey[] }>('/integrations360/api-keys').then(r => r.data.items),
  createApiKey: (d: { name: string; scope: 'rw' | 'ro' }) => api.post<{ item: ApiKey; key: string }>('/integrations360/api-keys', d).then(r => r.data),
  revokeApiKey: (id: number) => api.delete(`/integrations360/api-keys/${id}`),
  webhooks: () => api.get<{ items: Webhook[]; events: string[] }>('/integrations360/webhooks').then(r => r.data),
  createWebhook: (d: { url: string; events: string[] }) => api.post<{ item: Webhook; secret: string }>('/integrations360/webhooks', d).then(r => r.data),
  deleteWebhook: (id: number) => api.delete(`/integrations360/webhooks/${id}`),
  connectedApps: () => api.get<{ items: ConnectedApp[] }>('/integrations360/connected-apps').then(r => r.data.items),
  revokeApp: (appId: number) => api.delete(`/integrations360/connected-apps/${appId}`),
}
