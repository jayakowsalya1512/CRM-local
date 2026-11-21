import api from '@/services/api'

// Thin wrapper over the Team Chat REST API (backend/app/routers/chat_router.py).
// Mirrors this codebase's existing convention (plain axios calls, no TanStack Query) —
// see LeadsListPage.tsx for the pattern this follows.

export type ChatConversationType = 'dm' | 'group'
// 'online'/'away'/'dnd' are manual overrides a connected user can set; the backend always
// reports 'offline' once they have no live connection, regardless of what they last set.
export type PresenceStatus = 'online' | 'away' | 'dnd' | 'offline'

export type ChatConversationSummary = {
  id: number
  type: ChatConversationType
  name: string | null
  avatar_url: string | null
  dm_user_id: number | null
  description: string | null
  is_private: boolean
  announcement_mode: boolean
  last_message_at: string | null
  last_message_preview: string | null
  member_role: 'owner' | 'admin' | 'member'
  is_pinned: boolean
  is_archived: boolean
  muted_until: string | null
  unread_count: number
}

export type ChatAttachment = {
  id: number
  name: string
  content_type: string | null
  size_bytes: number
  is_image: boolean
  url: string
  created_at?: string
  message_id?: number
}

export type ChatReaction = { emoji: string; count: number; reacted_by_me: boolean }

export type ChatMessage = {
  id: number
  conversation_id: number
  sender_id: number | null
  sender_name: string | null
  sender_avatar_url: string | null
  message_type: 'text' | 'file' | 'image' | 'system' | 'poll' | 'crm_record'
  content: string
  is_deleted: boolean
  is_edited: boolean
  reply_to_message_id: number | null
  thread_root_id: number | null
  forwarded_from_message_id: number | null
  mentions: number[] | null
  extra_data: Record<string, any> | null
  created_at: string
  edited_at: string | null
  is_pinned: boolean
  is_bookmarked: boolean
  read_by_count: number
  member_count: number
  attachments: ChatAttachment[]
  reactions: ChatReaction[]
  _pending?: boolean
  _failed?: boolean
}

export type ChatMember = { user_id: number; name: string; avatar_url: string | null; role: string; joined_at: string }

export type ChatPoll = {
  id: number
  message_id: number
  question: string
  is_multi_choice: boolean
  is_anonymous: boolean
  closed: boolean
  total_votes: number
  options: { id: number; text: string; votes: number; voted_by_me: boolean }[]
}

const base = '/team-chat'

export const chatApi = {
  listConversations: (params?: { kind?: string; unread_only?: boolean; search?: string }) =>
    api.get<ChatConversationSummary[]>(`${base}/conversations`, { params }),
  createDM: (user_id: number) => api.post<{ id: number }>(`${base}/conversations/dm`, { user_id }),
  createGroup: (body: { name: string; member_ids: number[]; description?: string; is_private?: boolean }) =>
    api.post<{ id: number }>(`${base}/conversations/group`, body),
  updateGroup: (id: number, body: Partial<{ name: string; description: string; avatar_url: string; is_private: boolean; announcement_mode: boolean }>) =>
    api.patch(`${base}/conversations/${id}`, body),
  deleteGroup: (id: number) => api.delete(`${base}/conversations/${id}`),
  setFlags: (id: number, body: Partial<{ is_pinned: boolean; is_archived: boolean; muted_until: string; unmute: boolean }>) =>
    api.patch(`${base}/conversations/${id}/flags`, body),
  listMembers: (id: number) => api.get<ChatMember[]>(`${base}/conversations/${id}/members`),
  addMembers: (id: number, user_ids: number[]) => api.post<{ added: number[] }>(`${base}/conversations/${id}/members`, { user_ids }),
  removeMember: (id: number, userId: number) => api.delete(`${base}/conversations/${id}/members/${userId}`),
  setMemberRole: (id: number, userId: number, role: 'admin' | 'member') =>
    api.patch(`${base}/conversations/${id}/members/${userId}/role`, { role }),
  setRetention: (id: number, retention_days: number | null) =>
    api.patch(`${base}/conversations/${id}/retention`, { retention_days }),
  exportConversation: (id: number) => api.get<ChatMessage[]>(`${base}/conversations/${id}/export`),

  listMessages: (id: number, params?: { before_id?: number; limit?: number }) =>
    api.get<ChatMessage[]>(`${base}/conversations/${id}/messages`, { params }),
  sendMessage: (id: number, body: { content?: string; message_type?: string; reply_to_message_id?: number | null; mentions?: number[]; client_token?: string }) =>
    api.post<ChatMessage>(`${base}/conversations/${id}/messages`, body),
  editMessage: (messageId: number, content: string) => api.patch<ChatMessage>(`${base}/messages/${messageId}`, { content }),
  deleteMessage: (messageId: number) => api.delete(`${base}/messages/${messageId}`),
  forwardMessage: (messageId: number, target_conversation_ids: number[]) =>
    api.post<ChatMessage[]>(`${base}/messages/${messageId}/forward`, { target_conversation_ids }),
  toggleReaction: (messageId: number, emoji: string) => api.post(`${base}/messages/${messageId}/reactions`, { emoji }),
  markRead: (id: number, up_to_message_id: number) => api.post(`${base}/conversations/${id}/read`, { up_to_message_id }),
  unreadCount: () => api.get<{ count: number }>(`${base}/unread-count`),
  search: (q: string, conversation_id?: number) => api.get<ChatMessage[]>(`${base}/search`, { params: { q, conversation_id } }),

  togglePin: (conversationId: number, messageId: number) => api.post(`${base}/conversations/${conversationId}/pins/${messageId}`),
  listPins: (conversationId: number) => api.get<ChatMessage[]>(`${base}/conversations/${conversationId}/pins`),
  toggleBookmark: (messageId: number, note?: string) => api.post(`${base}/messages/${messageId}/bookmark`, null, { params: { note } }),
  listBookmarks: () => api.get<ChatMessage[]>(`${base}/bookmarks`),

  listShared: (conversationId: number, params?: { kind?: string; search?: string }) =>
    api.get<ChatAttachment[]>(`${base}/conversations/${conversationId}/shared`, { params }),
  uploadAttachment: (conversationId: number, file: File, onProgress?: (pct: number) => void) => {
    const form = new FormData()
    form.append('file', file)
    return api.post<ChatMessage>(`${base}/conversations/${conversationId}/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => onProgress?.(e.total ? Math.round((e.loaded * 100) / e.total) : 0),
    })
  },

  shareCrmRecord: (conversationId: number, body: { module: string; record_id: number; label: string; ref_number?: string }) =>
    api.post<ChatMessage>(`${base}/conversations/${conversationId}/share-crm-record`, body),

  createPoll: (conversationId: number, body: { question: string; options: string[]; is_multi_choice?: boolean; is_anonymous?: boolean; closes_at?: string }) =>
    api.post<ChatPoll>(`${base}/conversations/${conversationId}/polls`, body),
  getPoll: (pollId: number) => api.get<ChatPoll>(`${base}/polls/${pollId}`),
  votePoll: (pollId: number, option_ids: number[]) => api.post<ChatPoll>(`${base}/polls/${pollId}/vote`, { option_ids }),

  scheduleMessage: (conversationId: number, content: string, scheduled_for: string) =>
    api.post(`${base}/conversations/${conversationId}/scheduled`, { content, scheduled_for }),
  listScheduled: (conversationId: number) => api.get(`${base}/conversations/${conversationId}/scheduled`),
  cancelScheduled: (id: number) => api.delete(`${base}/scheduled/${id}`),

  createReminder: (messageId: number, remind_at: string, note?: string) =>
    api.post(`${base}/messages/${messageId}/reminders`, { remind_at, note }),
  dueReminders: () => api.get<{ id: number; message_id: number; note: string | null; remind_at: string }[]>(`${base}/reminders/due`),
  dismissReminder: (id: number) => api.post(`${base}/reminders/${id}/dismiss`),

  saveDraft: (conversationId: number, content: string, reply_to_message_id?: number | null) =>
    api.put(`${base}/conversations/${conversationId}/draft`, { content, reply_to_message_id }),
  getDrafts: () => api.get<Record<number, { content: string; reply_to_message_id: number | null }>>(`${base}/drafts`),

  getNotificationPrefs: () => api.get(`${base}/notification-preferences`),
  updateNotificationPrefs: (body: Partial<{ in_app_enabled: boolean; desktop_enabled: boolean; sound_enabled: boolean; mentions_only: boolean }>) =>
    api.patch(`${base}/notification-preferences`, body),

  presence: (userIds: number[]) => api.get<{ online_user_ids: number[]; statuses: Record<number, PresenceStatus> }>(`${base}/presence`, { params: { user_ids: userIds.join(',') } }),
  setPresenceStatus: (status: PresenceStatus) => api.patch(`${base}/presence/status`, { status }),
  auditLog: (conversationId: number) => api.get(`${base}/conversations/${conversationId}/audit-log`),

  // Attachments are only ever reachable with a valid Bearer token (checked against
  // conversation membership server-side), so a bare <img src="..."> can't be used —
  // the browser won't attach our Authorization header to it. Fetch as a blob instead.
  fetchAttachmentBlobUrl: async (attachmentId: number): Promise<string> => {
    const { data } = await api.get(`${base}/attachments/${attachmentId}/download`, { responseType: 'blob' })
    return URL.createObjectURL(data as Blob)
  },
}

export default chatApi
