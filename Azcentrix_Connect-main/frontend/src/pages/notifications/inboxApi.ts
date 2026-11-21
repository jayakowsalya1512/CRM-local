// Inbox & Notifications – typed calls to /api/v1/inbox and /api/v1/notifications.
import api from '@/services/api'

export const FOLDERS = ['Inbox', 'Starred', 'Sent', 'Drafts', 'Scheduled', 'Archive', 'Trash'] as const
export type Folder = typeof FOLDERS[number]
export type MailLabel = '' | 'Internal' | 'External' | 'Linked'

export interface RecordLink { module: string; id: number; ref: string; type: string; route: string }
export interface FolderCount { name: Folder; total: number; unread: number }
export interface MailItem {
  id: number; folder: Folder; from_name: string; from_email: string; to: string; cc: string; subject: string; preview: string
  is_read: boolean; is_starred: boolean; is_internal: boolean; attachments: number; link: RecordLink | null; account: string | null
  time: string | null; scheduled_at: string | null; delivery_status: string | null; thread_id: number | null
}
export interface MailDetail extends MailItem {
  body: string; bcc: string; from_mailbox: string | null; is_mine: boolean
  attachment_list: { id: number; name: string; size_kb: number | null; url: string | null; document_key: string | null }[]
  recipients: { kind: string; email: string; name: string | null }[]
  thread: { id: number; from_name: string; time: string | null; preview: string; folder: string }[]
  record: CrmRecord | null; open_count: number; click_count: number; track_opens: boolean; delivery_error: string | null
  assigned_to: string | null; can_create_lead: boolean; in_reply_to_id: number | null
}
export interface CrmRecord {
  module: string; id: number; ref: string; type: string; title: string; customer: string | null; contact: string | null
  email: string | null; value: number | null; value_label: string; tender_no: string | null; route: string; label: string
}
export interface Mailbox { address: string; name: string; domain: string; smtp_configured: boolean; mode: string; mailboxes: { address: string; label: string }[] }
export interface Template { id: number; name: string; subject: string | null; body: string }
export interface HubDoc { key: string; name: string; size_kb: number | null; source: string; record_label: string }
export interface People { colleagues: { id: number; name: string; email: string; role: string; designation: string | null }[]; contacts: { name: string; email: string; account: string }[] }
export interface ComposePayload {
  action: 'send' | 'draft'; draft_id?: number | null; from_mailbox?: string; to: string; cc: string; bcc: string; subject: string; body: string
  link_module?: string | null; link_record_id?: number | null; attachments: { key: string }[]; track: boolean; schedule?: string; reply_to_id?: number | null
}
export interface NotifItem {
  id: number; title: string; message: string; text: string; action: string | null; module: string | null; record_id: number | null
  is_read: boolean; created_at: string | null; record: { type: string; ref: string; route: string } | null
}
export interface DeliveryPref { key: string; label: string; enabled: boolean; channels: string[]; digest_time: string | null; summary: string }

export const errMsg = (e: any, fallback = 'Something went wrong') => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return fallback
}

export const inboxApi = {
  mailbox: () => api.get<Mailbox>('/inbox/mailbox').then(r => r.data),
  list: (folder: Folder, label: MailLabel, q: string) =>
    api.get<{ items: MailItem[]; folders: FolderCount[] }>('/inbox/messages', { params: { folder, label, q } }).then(r => r.data),
  get: (id: number, markRead = true) => api.get<MailDetail>(`/inbox/messages/${id}`, { params: { mark_read: markRead } }).then(r => r.data),
  patch: (id: number, body: Partial<{ is_read: boolean; is_starred: boolean; folder: string }>) => api.patch<MailItem>(`/inbox/messages/${id}`, body).then(r => r.data),
  remove: (id: number) => api.delete<{ ok: boolean; deleted: boolean }>(`/inbox/messages/${id}`).then(r => r.data),
  restore: (id: number) => api.post<MailItem>(`/inbox/messages/${id}/restore`).then(r => r.data),
  cancelSchedule: (id: number) => api.post<MailItem>(`/inbox/messages/${id}/cancel-schedule`).then(r => r.data),
  compose: (body: ComposePayload) => api.post<{ message: MailItem; status: string; scheduled_at?: string; internal?: number; external?: number; error?: string | null }>('/inbox/messages', body).then(r => r.data),
  link: (id: number, module: string, record_id: number) => api.post<MailDetail>(`/inbox/messages/${id}/link`, { module, record_id }).then(r => r.data),
  task: (id: number) => api.post<{ kind: string; route: string; due: string; title: string }>(`/inbox/messages/${id}/task`, {}).then(r => r.data),
  lead: (id: number) => api.post<{ id: number; ref: string; route: string }>(`/inbox/messages/${id}/lead`).then(r => r.data),
  assign: (id: number, user_id: number, add_note: boolean) => api.post<{ assigned_to: string }>(`/inbox/messages/${id}/assign`, { user_id, add_note }).then(r => r.data),
  records: (q = '') => api.get<{ items: CrmRecord[] }>('/inbox/records', { params: { q } }).then(r => r.data.items),
  people: () => api.get<People>('/inbox/people').then(r => r.data),
  templates: () => api.get<{ items: Template[] }>('/inbox/templates').then(r => r.data.items),
  render: (id: number, link_module?: string | null, link_record_id?: number | null) =>
    api.post<{ subject: string; body: string }>(`/inbox/templates/${id}/render`, { link_module, link_record_id }).then(r => r.data),
  aiDraft: (b: { link_module?: string | null; link_record_id?: number | null; subject: string; reply_to_id?: number | null }) =>
    api.post<{ body: string; source: string }>('/inbox/ai-draft', b).then(r => r.data),
  documents: () => api.get<{ items: HubDoc[]; allowed: boolean }>('/inbox/documents').then(r => r.data),
  unread: () => api.get<{ unread_count: number }>('/inbox/unread-count').then(r => r.data.unread_count),
}

export const notifApi = {
  feed: (tab: 'All' | 'Unread' | 'Mentions') =>
    api.get<{ items: NotifItem[]; counts: Record<string, number>; unread_count: number }>('/notifications/feed', { params: { tab } }).then(r => r.data),
  read: (id: number) => api.put<{ unread_count: number }>(`/notifications/${id}/read`).then(r => r.data),
  readAll: () => api.put<{ unread_count: number }>('/notifications/mark-all-read').then(r => r.data),
  prefs: () => api.get<{ items: DeliveryPref[] }>('/notifications/preferences').then(r => r.data.items),
  setPref: (key: string, enabled: boolean) => api.put<{ items: DeliveryPref[] }>(`/notifications/preferences/${key}`, { enabled }).then(r => r.data.items),
}

// Prototype time labels: "09:12", "Yesterday", "Monday", "12 Nov".
export function mailTime(iso: string | null, scheduled = false): string {
  if (!iso) return ''
  const d = new Date(iso), now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(d) - day(now)) / 864e5)
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (scheduled) {
    if (diff === 0) return `Today ${hm}`
    if (diff === 1) return `Tomorrow ${hm}`
    return `${d.toLocaleDateString('en-GB', { weekday: diff < 7 ? 'long' : undefined, day: diff < 7 ? undefined : '2-digit', month: diff < 7 ? undefined : 'short' })} ${hm}`
  }
  if (diff === 0) return hm
  if (diff === -1) return 'Yesterday'
  if (diff > -7 && diff < 0) return d.toLocaleDateString('en-GB', { weekday: 'long' })
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

// Prototype notification times: "just now", "3h ago", "1d ago".
export function ago(iso: string | null): string {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export const fmtSize = (kb: number | null) => kb == null ? '' : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
