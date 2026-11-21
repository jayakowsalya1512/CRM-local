import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft, FileText, Megaphone, MoreVertical, Paperclip, Pin,
  PinOff, Plus, Reply, Search, Send, Smile, Users, X,
} from 'lucide-react'
import api from '@/services/api'
import { useAuthStore } from '@/store'
import { useToast } from '@/components/ui/ToastContext'
import { usePermissions } from '@/hooks'
import chatApi, { type ChatConversationSummary, type ChatMessage, type PresenceStatus } from '@/services/chatApi'
import useChatSocket, { type ChatSocketEvent } from '@/hooks/useChatSocket'
import NewChatModal from './NewChatModal'
import PresenceDot, { STATUS_LABEL } from './PresenceDot'
import './chat.css'

const STATUS_OPTIONS: PresenceStatus[] = ['online', 'away', 'dnd']
const PRESENCE_POLL_MS = 20_000

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '👏', '🔥', '✅', '😀', '😊', '🤔', '👌', '🚀', '📌']
const PAGE_SIZE = 40

function timeLabel(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })
}

function initials(name: string | null | undefined): string {
  if (!name) return '?'
  return name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('')
}

type FilterTab = 'all' | 'dm' | 'group' | 'unread' | 'pinned'

export default function TeamChatPage() {
  const me = useAuthStore((s) => s.user)
  const { success, error: showError } = useToast()
  const { can } = usePermissions()

  const [conversations, setConversations] = useState<ChatConversationSummary[]>([])
  const [loadingConvs, setLoadingConvs] = useState(true)
  const [filter, setFilter] = useState<FilterTab>('all')
  const [convSearch, setConvSearch] = useState('')
  const [activeId, setActiveId] = useState<number | null>(null)

  const [messagesById, setMessagesById] = useState<Record<number, ChatMessage[]>>({})
  const [hasMoreById, setHasMoreById] = useState<Record<number, boolean>>({})
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [typingByConv, setTypingByConv] = useState<Record<number, Set<number>>>({})

  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [showEmoji, setShowEmoji] = useState(false)
  // Rendered via a portal (see renderPopup below) so it's never clipped by .chat-messages'
  // overflow-y:auto — only one message popup (reactions OR the ⋮ menu) can be open at a time.
  const [popup, setPopup] = useState<{ kind: 'reactions' | 'actions'; messageId: number; top: number; left: number } | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')

  const [showNewChat, setShowNewChat] = useState(false)
  const [rightPanel, setRightPanel] = useState<'none' | 'info' | 'media' | 'pins'>('none')
  const [members, setMembers] = useState<any[]>([])
  const [showAddMembers, setShowAddMembers] = useState(false)
  const [addableUsers, setAddableUsers] = useState<{ id: number; full_name: string }[]>([])
  const [addSelection, setAddSelection] = useState<Set<number>>(new Set())
  const [addBusy, setAddBusy] = useState(false)
  const [shared, setShared] = useState<{ images: any[]; docs: any[] }>({ images: [], docs: [] })
  const [pinned, setPinned] = useState<ChatMessage[]>([])

  const [presence, setPresence] = useState<Record<number, PresenceStatus>>({})
  const [myStatus, setMyStatus] = useState<PresenceStatus>('online')
  const [showStatusMenu, setShowStatusMenu] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeIdRef = useRef<number | null>(null)
  activeIdRef.current = activeId

  // ── conversations ──────────────────────────────────────────────────────────
  const loadConversations = useCallback(() => {
    chatApi.listConversations({
      kind: filter === 'dm' || filter === 'group' ? filter : undefined,
      unread_only: filter === 'unread',
      search: convSearch || undefined,
    }).then(({ data }) => setConversations(data)).catch(() => {}).finally(() => setLoadingConvs(false))
  }, [filter, convSearch])

  useEffect(() => { loadConversations() }, [loadConversations])

  const visibleConversations = useMemo(() => {
    if (filter !== 'pinned') return conversations
    return conversations.filter((c) => c.is_pinned)
  }, [conversations, filter])

  const activeConv = conversations.find((c) => c.id === activeId) || null
  const activeMessages = activeId ? messagesById[activeId] || [] : []

  // ── presence ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!me?.id) return
    chatApi.presence([me.id]).then(({ data }) => setMyStatus(data.statuses?.[me.id] === 'offline' ? 'online' : data.statuses?.[me.id] || 'online')).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id])

  const watchedUserIds = useMemo(() => {
    const ids = new Set<number>()
    conversations.forEach((c) => { if (c.dm_user_id) ids.add(c.dm_user_id) })
    members.forEach((m) => ids.add(m.user_id))
    return Array.from(ids)
  }, [conversations, members])

  useEffect(() => {
    if (watchedUserIds.length === 0) return
    let alive = true
    const poll = () => chatApi.presence(watchedUserIds).then(({ data }) => { if (alive) setPresence((p) => ({ ...p, ...data.statuses })) }).catch(() => {})
    poll()
    const timer = window.setInterval(poll, PRESENCE_POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [watchedUserIds])

  const setStatus = (status: PresenceStatus) => {
    setMyStatus(status)
    setShowStatusMenu(false)
    chatApi.setPresenceStatus(status).catch(() => {})
  }

  // ── messages ───────────────────────────────────────────────────────────────
  // Double rAF: one frame for React to commit the new messages into the DOM, a second
  // for the browser to have actually laid them out, so scrollHeight is the real final value.
  const scrollToBottom = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }))

  const loadMessages = useCallback((conversationId: number, beforeId?: number) => {
    setLoadingMessages(true)
    chatApi.listMessages(conversationId, { before_id: beforeId, limit: PAGE_SIZE }).then(({ data }) => {
      const ordered = [...data].reverse()
      setHasMoreById((m) => ({ ...m, [conversationId]: data.length === PAGE_SIZE }))
      setMessagesById((m) => ({
        ...m,
        [conversationId]: beforeId ? [...ordered, ...(m[conversationId] || [])] : ordered,
      }))
      if (!beforeId && ordered.length) {
        chatApi.markRead(conversationId, ordered[ordered.length - 1].id).catch(() => {})
        setConversations((cs) => cs.map((c) => c.id === conversationId ? { ...c, unread_count: 0 } : c))
      }
      // Initial fetch for a conversation (not "load older" pagination, which preserves scroll
      // position itself) always lands on the newest message — only once this data has actually
      // arrived and rendered, not optimistically before the fetch even resolves.
      if (!beforeId && conversationId === activeIdRef.current) scrollToBottom()
    }).catch(() => showError('Could not load messages')).finally(() => setLoadingMessages(false))
  }, [showError])

  const openConversation = (id: number) => {
    setActiveId(id)
    setRightPanel('none')
    setShowAddMembers(false)
    setReplyTo(null)
    if (!messagesById[id]) loadMessages(id)
    else scrollToBottom() // already cached — content is already in the DOM, no fetch to wait on
    chatApi.getDrafts().then(({ data }) => setDraft(data[id]?.content || '')).catch(() => {})
  }

  const onScrollTop = () => {
    const el = listRef.current
    if (!el || !activeId || loadingMessages || !hasMoreById[activeId]) return
    if (el.scrollTop < 60) {
      const oldest = (messagesById[activeId] || [])[0]
      if (!oldest) return
      const prevHeight = el.scrollHeight
      loadMessages(activeId, oldest.id)
      requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight - prevHeight })
    }
  }

  // ── realtime ───────────────────────────────────────────────────────────────
  const handleEvent = useCallback((event: ChatSocketEvent) => {
    switch (event.type) {
      case 'message_new': {
        const msg = event.data as ChatMessage
        // Our own sends are already reconciled by sendMessage()'s HTTP response —
        // only append here for messages from other senders, to avoid a double entry.
        if (msg.sender_id !== me?.id) {
          setMessagesById((m) => {
            const list = m[msg.conversation_id] || []
            if (list.some((x) => x.id === msg.id)) return m
            return { ...m, [msg.conversation_id]: [...list, msg] }
          })
        }
        setConversations((cs) => cs.map((c) => c.id === msg.conversation_id
          ? { ...c, last_message_at: msg.created_at, last_message_preview: msg.content?.slice(0, 120) || c.last_message_preview,
              unread_count: msg.conversation_id === activeIdRef.current ? 0 : c.unread_count + (msg.sender_id === me?.id ? 0 : 1) }
          : c))
        if (msg.conversation_id === activeIdRef.current) {
          chatApi.markRead(msg.conversation_id, msg.id).catch(() => {})
          requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight })
        }
        break
      }
      case 'message_edited': {
        const msg = event.data as ChatMessage
        setMessagesById((m) => ({ ...m, [msg.conversation_id]: (m[msg.conversation_id] || []).map((x) => x.id === msg.id ? msg : x) }))
        break
      }
      case 'message_deleted': {
        const { id, conversation_id } = event.data
        setMessagesById((m) => ({ ...m, [conversation_id]: (m[conversation_id] || []).map((x) => x.id === id ? { ...x, is_deleted: true, content: '' } : x) }))
        break
      }
      case 'reaction_updated': {
        loadConversations()
        break
      }
      case 'typing': {
        const { conversation_id, user_id, is_typing } = event.data
        if (user_id === me?.id) return
        setTypingByConv((t) => {
          const next = new Set(t[conversation_id] || [])
          is_typing ? next.add(user_id) : next.delete(user_id)
          return { ...t, [conversation_id]: next }
        })
        break
      }
      case 'conversation_updated':
      case 'conversation_deleted':
        loadConversations()
        break
      case 'presence_updated': {
        const { user_id, status } = event.data
        setPresence((p) => ({ ...p, [user_id]: status }))
        break
      }
      default:
        break
    }
  }, [me?.id, loadConversations])

  const { sendTyping } = useChatSocket(handleEvent)

  useEffect(() => {
    if (!showStatusMenu) return
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('.chat-status-picker')) setShowStatusMenu(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showStatusMenu])

  useEffect(() => {
    if (!popup) return
    const close = (e: Event) => {
      const target = e.target as HTMLElement
      if (target.closest('.chat-floating-popup') || target.closest('[data-popup-trigger]')) return
      setPopup(null)
    }
    const escClose = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopup(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escClose)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escClose) }
  }, [popup])

  // refresh a single message's reactions/edit state by re-fetching the page if needed
  useEffect(() => {
    if (!activeId) return
    const id = activeId
    const onFocus = () => loadMessages(id)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [activeId, loadMessages])

  // ── composer ───────────────────────────────────────────────────────────────
  const onDraftChange = (value: string) => {
    setDraft(value)
    if (!activeId) return
    sendTyping(activeId, value.length > 0)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    typingTimerRef.current = setTimeout(() => activeId && sendTyping(activeId, false), 2000)
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current)
    draftSaveTimerRef.current = setTimeout(() => chatApi.saveDraft(activeId, value, replyTo?.id ?? null).catch(() => {}), 500)
  }

  const sendMessage = () => {
    if (!activeId || !draft.trim()) return
    const content = draft.trim()
    const clientToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const optimistic: ChatMessage = {
      id: -Date.now(), conversation_id: activeId, sender_id: me?.id ?? null, sender_name: me?.full_name ?? null,
      sender_avatar_url: null, message_type: 'text', content, is_deleted: false, is_edited: false,
      reply_to_message_id: replyTo?.id ?? null, thread_root_id: null, forwarded_from_message_id: null,
      mentions: null, extra_data: null, created_at: new Date().toISOString(), edited_at: null,
      is_pinned: false, is_bookmarked: false, read_by_count: 0, member_count: 0, attachments: [], reactions: [],
      _pending: true,
    }
    setMessagesById((m) => ({ ...m, [activeId]: [...(m[activeId] || []), optimistic] }))
    setDraft(''); setReplyTo(null)
    chatApi.saveDraft(activeId, '').catch(() => {})
    requestAnimationFrame(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight })

    chatApi.sendMessage(activeId, { content, reply_to_message_id: replyTo?.id, client_token: clientToken }).then(({ data }) => {
      setMessagesById((m) => ({ ...m, [activeId]: (m[activeId] || []).map((x) => x.id === optimistic.id ? data : x) }))
    }).catch(() => {
      setMessagesById((m) => ({ ...m, [activeId]: (m[activeId] || []).map((x) => x.id === optimistic.id ? { ...x, _pending: false, _failed: true } : x) }))
      showError('Message failed to send — tap to retry')
    })
  }

  const retryMessage = (msg: ChatMessage) => {
    if (!activeId) return
    setMessagesById((m) => ({ ...m, [activeId]: (m[activeId] || []).filter((x) => x.id !== msg.id) }))
    setDraft(msg.content)
  }

  const onUploadFile = (file: File) => {
    if (!activeId) return
    chatApi.uploadAttachment(activeId, file).then(({ data }) => {
      setMessagesById((m) => ({ ...m, [activeId]: [...(m[activeId] || []), data] }))
    }).catch((err) => showError(err?.response?.data?.detail || 'Upload failed'))
  }

  // ── message actions ────────────────────────────────────────────────────────
  const toggleReaction = (messageId: number, emoji: string) => {
    if (!activeId) return
    chatApi.toggleReaction(messageId, emoji).then(() => loadMessages(activeId)).catch(() => {})
    setPopup(null)
  }

  const deleteMessage = (messageId: number) => {
    if (!activeId || !window.confirm('Delete this message?')) return
    chatApi.deleteMessage(messageId).then(() => {
      setMessagesById((m) => ({ ...m, [activeId]: (m[activeId] || []).map((x) => x.id === messageId ? { ...x, is_deleted: true, content: '' } : x) }))
    }).catch(() => showError('Could not delete message'))
    setPopup(null)
  }

  const saveEdit = (messageId: number) => {
    if (!activeId || !editText.trim()) return
    chatApi.editMessage(messageId, editText.trim()).then(({ data }) => {
      setMessagesById((m) => ({ ...m, [activeId]: (m[activeId] || []).map((x) => x.id === messageId ? data : x) }))
      setEditingId(null)
    }).catch(() => showError('Could not edit message'))
  }

  const copyMessage = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => success('Copied')).catch(() => {})
    setPopup(null)
  }

  const togglePin = (messageId: number) => {
    if (!activeId) return
    chatApi.togglePin(activeId, messageId).then(() => loadMessages(activeId)).catch(() => {})
    setPopup(null)
  }

  const toggleBookmark = (messageId: number) => {
    chatApi.toggleBookmark(messageId).then(() => success('Saved to bookmarks')).catch(() => {})
    setPopup(null)
  }

  const openPopup = (kind: 'reactions' | 'actions', messageId: number, triggerEl: HTMLElement) => {
    setPopup((p) => {
      if (p?.kind === kind && p.messageId === messageId) return null
      const rect = triggerEl.getBoundingClientRect()
      const width = kind === 'reactions' ? 230 : 140
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
      const estimatedHeight = kind === 'reactions' ? 70 : 170
      const top = rect.bottom + estimatedHeight > window.innerHeight ? Math.max(8, rect.top - estimatedHeight - 6) : rect.bottom + 6
      return { kind, messageId, top, left }
    })
  }

  // ── right panel loaders ────────────────────────────────────────────────────
  const openRightPanel = (panel: 'info' | 'media' | 'pins') => {
    if (!activeId) return
    setRightPanel(panel)
    if (panel === 'info') chatApi.listMembers(activeId).then(({ data }) => setMembers(data)).catch(() => {})
    if (panel === 'media') Promise.all([
      chatApi.listShared(activeId, { kind: 'image' }), chatApi.listShared(activeId, { kind: 'document' }),
    ]).then(([imgs, docs]) => setShared({ images: imgs.data, docs: docs.data })).catch(() => {})
    if (panel === 'pins') chatApi.listPins(activeId).then(({ data }) => setPinned(data)).catch(() => {})
  }

  // ── add members to an existing group ────────────────────────────────────
  const openAddMembers = () => {
    setAddSelection(new Set())
    setShowAddMembers(true)
    api.get<{ id: number; full_name: string; is_active?: boolean }[]>('/auth/users').then(({ data }) => {
      const existing = new Set(members.map((m) => m.user_id))
      setAddableUsers(data.filter((u) => !existing.has(u.id) && u.is_active !== false))
    }).catch(() => setAddableUsers([]))
  }
  const toggleAddSelection = (id: number) => setAddSelection((s) => {
    const next = new Set(s)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const submitAddMembers = () => {
    if (!activeId || addSelection.size === 0) return
    setAddBusy(true)
    chatApi.addMembers(activeId, Array.from(addSelection)).then(() => {
      success('Members added')
      setShowAddMembers(false)
      openRightPanel('info')
    }).catch((err) => showError(err?.response?.data?.detail || 'Could not add members')).finally(() => setAddBusy(false))
  }

  // ── create conversations ───────────────────────────────────────────────────
  const createDM = (userId: number) => {
    chatApi.createDM(userId).then(({ data }) => {
      setShowNewChat(false); loadConversations(); openConversation(data.id)
    }).catch(() => showError('Could not start chat'))
  }
  const createGroup = (name: string, memberIds: number[], description: string, isPrivate: boolean) => {
    chatApi.createGroup({ name, member_ids: memberIds, description, is_private: isPrivate }).then(({ data }) => {
      setShowNewChat(false); loadConversations(); openConversation(data.id)
    }).catch((err) => showError(err?.response?.data?.detail || 'Could not create group'))
  }

  const typingNames = activeId ? Array.from(typingByConv[activeId] || []) : []

  return (
    <div className="chat-page">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <h2>Team Chat</h2>
          <span className="flex-1" />
          <div className="chat-status-picker">
            <button type="button" className="chat-status-trigger" onClick={() => setShowStatusMenu((s) => !s)}>
              <PresenceDot status={myStatus} size={8} /><span>{STATUS_LABEL[myStatus]}</span>
            </button>
            {showStatusMenu && (
              <div className="chat-status-menu">
                {STATUS_OPTIONS.map((s) => (
                  <button type="button" key={s} onClick={() => setStatus(s)}><PresenceDot status={s} size={8} /> {STATUS_LABEL[s]}</button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowNewChat(true)}><Plus size={14} /> New</button>
        </div>
        <div className="chat-search">
          <Search size={14} />
          <input placeholder="Search conversations…" value={convSearch} onChange={(e) => setConvSearch(e.target.value)} />
        </div>
        <div className="chat-filter-tabs">
          {(['all', 'dm', 'group', 'unread', 'pinned'] as FilterTab[]).map((f) => (
            <button key={f} type="button" className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'dm' ? 'Individual' : f === 'group' ? 'Group' : f === 'unread' ? 'Unread' : 'Pinned'}
            </button>
          ))}
        </div>
        <div className="chat-conv-list">
          {loadingConvs && <div className="chat-empty-hint">Loading…</div>}
          {!loadingConvs && visibleConversations.length === 0 && <div className="chat-empty-hint">No conversations yet</div>}
          {visibleConversations.map((c) => (
            <button key={c.id} type="button" className={`chat-conv-row ${c.id === activeId ? 'active' : ''}`} onClick={() => openConversation(c.id)}>
              <span className="chat-avatar-wrap">
                <span className="chat-avatar">{c.type === 'group' ? <Users size={14} /> : initials(c.name)}</span>
                {c.type === 'dm' && c.dm_user_id && presence[c.dm_user_id] && (
                  <span className="chat-avatar-dot"><PresenceDot status={presence[c.dm_user_id]} /></span>
                )}
              </span>
              <span className="chat-conv-main">
                <span className="chat-conv-top">
                  <b>{c.name || 'Unnamed'}</b>
                  <small>{timeLabel(c.last_message_at)}</small>
                </span>
                <span className="chat-conv-bottom">
                  <span className="chat-conv-preview">{c.last_message_preview || 'No messages yet'}</span>
                  {c.is_pinned && <Pin size={11} />}
                  {c.muted_until && <span className="chat-muted-dot" title="Muted" />}
                  {c.unread_count > 0 && <em className="chat-badge">{c.unread_count}</em>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        {!activeConv && <div className="chat-empty-state">Select a conversation or start a new chat</div>}
        {activeConv && (
          <>
            <header className="chat-header">
              <span className="chat-avatar-wrap">
                <span className="chat-avatar">{activeConv.type === 'group' ? <Users size={16} /> : initials(activeConv.name)}</span>
                {activeConv.type === 'dm' && activeConv.dm_user_id && presence[activeConv.dm_user_id] && (
                  <span className="chat-avatar-dot"><PresenceDot status={presence[activeConv.dm_user_id]} /></span>
                )}
              </span>
              <div className="chat-header-text">
                <b>{activeConv.name || 'Unnamed'}</b>
                <small>
                  {activeConv.type === 'group'
                    ? `${activeConv.member_role === 'owner' ? 'You are the owner' : 'Group'}${activeConv.announcement_mode ? ' · Announcements only' : ''}`
                    : activeConv.dm_user_id ? STATUS_LABEL[presence[activeConv.dm_user_id] || 'offline'] : 'Direct message'}
                </small>
              </div>
              <span className="flex-1" />
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => openRightPanel('pins')} title="Pinned messages"><Pin size={15} /></button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => openRightPanel('media')} title="Shared media"><FileText size={15} /></button>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => openRightPanel('info')} title="Conversation info"><MoreVertical size={15} /></button>
            </header>

            {activeConv.announcement_mode && activeConv.member_role === 'member' && (
              <div className="chat-announce-banner"><Megaphone size={14} /> Only admins can post in this group</div>
            )}

            <div className="chat-messages" ref={listRef} onScroll={onScrollTop}>
              {activeMessages.map((msg, idx) => {
                const prev = activeMessages[idx - 1]
                const showDay = !prev || dayLabel(prev.created_at) !== dayLabel(msg.created_at)
                const mine = msg.sender_id === me?.id
                return (
                  <div key={msg.id}>
                    {showDay && <div className="chat-day-divider"><span>{dayLabel(msg.created_at)}</span></div>}
                    <div className={`chat-bubble-row ${mine ? 'mine' : ''}`}>
                      {!mine && <span className="chat-avatar xs">{initials(msg.sender_name)}</span>}
                      <div className={`chat-bubble ${msg._pending ? 'pending' : ''} ${msg._failed ? 'failed' : ''}`}
                        onClick={() => msg._failed && retryMessage(msg)}>
                        {!mine && activeConv.type === 'group' && <div className="chat-bubble-sender">{msg.sender_name}</div>}
                        {msg.reply_to_message_id && (() => {
                          const parent = activeMessages.find((x) => x.id === msg.reply_to_message_id)
                          return parent ? <div className="chat-reply-preview"><Reply size={11} /> {parent.sender_name}: {parent.content.slice(0, 80)}</div> : null
                        })()}
                        {msg.is_deleted ? (
                          <i className="chat-deleted">This message was deleted</i>
                        ) : editingId === msg.id ? (
                          <div className="chat-edit-box">
                            <input value={editText} onChange={(e) => setEditText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveEdit(msg.id)} autoFocus />
                            <button type="button" onClick={() => saveEdit(msg.id)}>Save</button>
                            <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                          </div>
                        ) : (
                          <>
                            {msg.message_type === 'crm_record' && msg.extra_data ? (
                              <div className="chat-crm-card">
                                <b>{msg.extra_data.label}</b>
                                <small>{String(msg.extra_data.module).toUpperCase()} {msg.extra_data.ref_number ? `· ${msg.extra_data.ref_number}` : ''}</small>
                                <a href={`/${msg.extra_data.module}/${msg.extra_data.record_id}`}>Open record →</a>
                              </div>
                            ) : (
                              <div className="chat-bubble-text">{msg.content}</div>
                            )}
                            {msg.attachments.map((a) => <AttachmentView key={a.id} attachment={a} />)}
                            {msg.is_edited && <small className="chat-edited-tag">edited</small>}
                          </>
                        )}
                        <div className="chat-bubble-meta">
                          <span>{timeLabel(msg.created_at)}</span>
                          {mine && !msg.is_deleted && (
                            <span className="chat-ticks">{msg._pending ? '🕐' : msg.read_by_count > 0 ? '✓✓' : '✓'}</span>
                          )}
                        </div>
                        {msg.reactions.length > 0 && (
                          <div className="chat-reactions">
                            {msg.reactions.map((r) => (
                              <button key={r.emoji} type="button" className={r.reacted_by_me ? 'on' : ''} onClick={() => toggleReaction(msg.id, r.emoji)}>
                                {r.emoji} {r.count}
                              </button>
                            ))}
                          </div>
                        )}
                        {!msg.is_deleted && (
                          <div className="chat-bubble-actions">
                            <button type="button" data-popup-trigger title="React" onClick={(e) => openPopup('reactions', msg.id, e.currentTarget)}><Smile size={13} /></button>
                            <button type="button" title="Reply" onClick={() => setReplyTo(msg)}><Reply size={13} /></button>
                            <button type="button" data-popup-trigger title="More" onClick={(e) => openPopup('actions', msg.id, e.currentTarget)}><MoreVertical size={13} /></button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
              {typingNames.length > 0 && <div className="chat-typing">Someone is typing…</div>}
            </div>

            {replyTo && (
              <div className="chat-reply-bar">
                <Reply size={13} /> Replying to {replyTo.sender_name}: {replyTo.content.slice(0, 60)}
                <button type="button" onClick={() => setReplyTo(null)}><X size={13} /></button>
              </div>
            )}

            <div className="chat-composer">
              <label className="btn btn-ghost btn-icon btn-sm">
                <Paperclip size={16} />
                <input type="file" hidden onChange={(e) => e.target.files?.[0] && onUploadFile(e.target.files[0])} />
              </label>
              <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setShowEmoji((s) => !s)}><Smile size={16} /></button>
              <textarea
                rows={1} placeholder="Type a message…" value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
              />
              <button type="button" className="btn btn-primary btn-icon" onClick={sendMessage} disabled={!draft.trim()}><Send size={16} /></button>
              {showEmoji && (
                <div className="chat-emoji-pop composer">
                  {EMOJIS.map((e) => <button key={e} type="button" onClick={() => { onDraftChange(draft + e); setShowEmoji(false) }}>{e}</button>)}
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {activeConv && rightPanel !== 'none' && (
        <aside className="chat-right-panel">
          <div className="chat-right-head">
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setRightPanel('none')}><ChevronLeft size={15} /></button>
            <b>{rightPanel === 'info' ? 'Conversation info' : rightPanel === 'media' ? 'Shared media' : 'Pinned messages'}</b>
          </div>
          {rightPanel === 'info' && (
            <div className="chat-right-body">
              <div className="chat-info-row"><b>{activeConv.name}</b><small>{activeConv.description || 'No description'}</small></div>
              {activeConv.type === 'group' && (
                <div className="flex items-center" style={{ marginTop: 10 }}>
                  <h4 style={{ margin: 0 }}>Members ({members.length})</h4>
                  <span className="flex-1" />
                  {(activeConv.member_role === 'owner' || activeConv.member_role === 'admin') && (
                    <button type="button" className="tn-link" onClick={openAddMembers}><Plus size={12} /> Add members</button>
                  )}
                </div>
              )}
              {members.map((m) => (
                <div key={m.user_id} className="chat-member-row">
                  <span className="chat-avatar-wrap">
                    <span className="chat-avatar xs">{initials(m.name)}</span>
                    {presence[m.user_id] && <span className="chat-avatar-dot sm"><PresenceDot status={presence[m.user_id]} size={7} /></span>}
                  </span>
                  <span>{m.name}</span>
                  <small>{m.role}</small>
                </div>
              ))}
              {showAddMembers && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginTop: 8 }}>
                  <div className="flex items-center" style={{ marginBottom: 6 }}>
                    <b style={{ fontSize: 12 }}>Add members</b>
                    <span className="flex-1" />
                    <button type="button" onClick={() => setShowAddMembers(false)} style={{ border: 0, background: 'none', cursor: 'pointer' }}><X size={13} /></button>
                  </div>
                  <div className="chat-people-list" style={{ maxHeight: 140 }}>
                    {addableUsers.map((u) => (
                      <label key={u.id} className="chat-people-row">
                        <input type="checkbox" checked={addSelection.has(u.id)} onChange={() => toggleAddSelection(u.id)} />
                        <span className="chat-avatar sm">{initials(u.full_name)}</span>
                        <span>{u.full_name}</span>
                      </label>
                    ))}
                    {addableUsers.length === 0 && <div className="chat-empty-hint">Everyone is already in this group</div>}
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" style={{ marginTop: 8 }}
                    onClick={submitAddMembers} disabled={addSelection.size === 0 || addBusy}>
                    {addBusy ? 'Adding…' : `Add ${addSelection.size || ''}`.trim()}
                  </button>
                </div>
              )}
              <h4>Notifications</h4>
              <label className="chat-info-row">
                <input type="checkbox" checked={!!activeConv.muted_until} onChange={(e) => {
                  chatApi.setFlags(activeConv.id, e.target.checked
                    ? { muted_until: new Date(Date.now() + 365 * 86400000).toISOString() }
                    : { unmute: true }).then(loadConversations)
                }} /> Mute this conversation
              </label>
            </div>
          )}
          {rightPanel === 'media' && (
            <div className="chat-right-body">
              <h4>Images</h4>
              <div className="chat-media-grid">{shared.images.map((a) => <AttachmentThumb key={a.id} attachment={a} />)}</div>
              <h4>Documents</h4>
              {shared.docs.map((a) => <div key={a.id} className="chat-doc-row"><FileText size={14} /> {a.name}</div>)}
              {shared.images.length === 0 && shared.docs.length === 0 && <div className="chat-empty-hint">Nothing shared yet</div>}
            </div>
          )}
          {rightPanel === 'pins' && (
            <div className="chat-right-body">
              {pinned.length === 0 && <div className="chat-empty-hint">No pinned messages</div>}
              {pinned.map((m) => (
                <div key={m.id} className="chat-pinned-row">
                  <b>{m.sender_name}</b>
                  <p>{m.content}</p>
                  <button type="button" onClick={() => togglePin(m.id)}><PinOff size={12} /> Unpin</button>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} onCreateDM={createDM} onCreateGroup={createGroup} />}
      {popup && renderPopup()}
    </div>
  )

  function renderPopup() {
    if (!popup) return null
    const msg = activeMessages.find((m) => m.id === popup.messageId)
    if (!msg) return null
    const style = { top: popup.top, left: popup.left }
    if (popup.kind === 'reactions') {
      return createPortal(
        <div className="chat-floating-popup chat-emoji-pop" style={style}>
          {EMOJIS.map((e) => <button key={e} type="button" onClick={() => toggleReaction(msg.id, e)}>{e}</button>)}
        </div>,
        document.body,
      )
    }
    const mine = msg.sender_id === me?.id
    return createPortal(
      <div className="chat-floating-popup chat-action-menu" style={style}>
        <button type="button" onClick={() => copyMessage(msg.content)}>Copy</button>
        <button type="button" onClick={() => togglePin(msg.id)}>{msg.is_pinned ? 'Unpin' : 'Pin'}</button>
        <button type="button" onClick={() => toggleBookmark(msg.id)}>Bookmark</button>
        {mine && <button type="button" onClick={() => { setEditingId(msg.id); setEditText(msg.content); setPopup(null) }}>Edit</button>}
        {(mine || can('team_chat.delete_any_message')) && <button type="button" className="danger" onClick={() => deleteMessage(msg.id)}>Delete</button>}
      </div>,
      document.body,
    )
  }
}

function AttachmentView({ attachment }: { attachment: any }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    import('@/services/chatApi').then(({ default: capi }) => capi.fetchAttachmentBlobUrl(attachment.id)).then((u) => { if (active) setUrl(u) }).catch(() => {})
    return () => { active = false }
  }, [attachment.id])
  if (attachment.is_image) {
    return url ? <img src={url} alt={attachment.name} className="chat-attach-image" /> : <div className="chat-attach-loading">Loading image…</div>
  }
  return (
    <a className="chat-attach-file" href={url || undefined} download={attachment.name} onClick={(e) => { if (!url) e.preventDefault() }}>
      <FileText size={14} /> {attachment.name}
    </a>
  )
}

function AttachmentThumb({ attachment }: { attachment: any }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    import('@/services/chatApi').then(({ default: capi }) => capi.fetchAttachmentBlobUrl(attachment.id)).then((u) => { if (active) setUrl(u) }).catch(() => {})
    return () => { active = false }
  }, [attachment.id])
  return url ? <img src={url} alt={attachment.name} /> : <div className="chat-media-grid-placeholder" />
}
