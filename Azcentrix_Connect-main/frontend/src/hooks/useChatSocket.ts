import { useEffect, useRef } from 'react'
import { useAuthStore } from '@/store'

// Real-time client for Team Chat (backend/app/routers/chat_router.py `@router.websocket("/ws")`).
//
// Single shared connection, not one per caller: TeamChatFooterButton (always mounted) and
// TeamChatPage (only mounted while the widget is open) both call this hook — if each opened
// its own socket, closing/minimizing the widget would silently drop the connection entirely,
// which is exactly why background chat notifications stopped arriving before this fix. Every
// caller instead registers as a listener on one module-level socket that connects as soon as
// the first listener mounts and is torn down only when the last one unmounts.

export type ChatSocketEvent =
  | { type: 'message_new'; data: any }
  | { type: 'message_edited'; data: any }
  | { type: 'message_deleted'; data: { id: number; conversation_id: number } }
  | { type: 'reaction_updated'; data: any }
  | { type: 'read_receipt_updated'; data: any }
  | { type: 'typing'; data: { conversation_id: number; user_id: number; is_typing: boolean } }
  | { type: 'conversation_updated'; data: { conversation_id: number } }
  | { type: 'conversation_deleted'; data: { conversation_id: number } }
  | { type: 'pin_updated'; data: any }
  | { type: 'poll_updated'; data: any }
  | { type: 'mentioned'; data: any }
  | { type: 'presence_updated'; data: { user_id: number; status: 'online' | 'away' | 'dnd' | 'offline' } }
  | { type: 'pong'; data?: undefined }

function wsBaseUrl(): string {
  const apiBase = (import.meta.env.VITE_API_URL as string) || '/api/v1'
  if (/^https?:\/\//i.test(apiBase)) {
    return apiBase.replace(/^http/i, 'ws')
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${apiBase}`
}

const PING_INTERVAL_MS = 25_000
const MAX_BACKOFF_MS = 15_000

type Listener = (event: ChatSocketEvent) => void

class ChatSocketSingleton {
  private ws: WebSocket | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoff = 1000
  private listeners = new Set<Listener>()
  private tornDown = false

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    this.tornDown = false
    if (!this.ws) this.connect()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.teardown()
    }
  }

  send(payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  private connect() {
    const { access_token, tenant_slug } = useAuthStore.getState()
    if (!access_token || !tenant_slug) {
      this.reconnectTimer = setTimeout(() => this.connect(), 2000)
      return
    }
    const url = `${wsBaseUrl()}/team-chat/ws?token=${encodeURIComponent(access_token)}&tenant=${encodeURIComponent(tenant_slug)}`
    const ws = new WebSocket(url)
    this.ws = ws

    ws.onopen = () => {
      this.backoff = 1000
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS)
    }
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data)
        if (parsed?.type) this.listeners.forEach((l) => l(parsed))
      } catch {
        // ignore malformed frames
      }
    }
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      if (!this.tornDown && this.listeners.size > 0) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
      }
    }
    ws.onerror = () => ws.close()
  }

  private teardown() {
    this.tornDown = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }
}

const singleton = new ChatSocketSingleton()

export function useChatSocket(onEvent: (event: ChatSocketEvent) => void) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    const unsubscribe = singleton.subscribe((event) => onEventRef.current(event))
    return unsubscribe
  }, [])

  const sendTyping = (conversationId: number, isTyping: boolean) =>
    singleton.send({ type: 'typing', conversation_id: conversationId, is_typing: isTyping })

  return { sendTyping }
}

export default useChatSocket
