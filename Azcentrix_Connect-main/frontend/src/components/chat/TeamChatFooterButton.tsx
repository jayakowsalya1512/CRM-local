// Footer entry point for Team Chat, next to Quick note — opens the floating
// widget (ChatWidget.tsx, mounted once in AppLayout) instead of navigating away.
//
// Also the app's one always-mounted chat listener: as long as this button is rendered
// (i.e. the user has team_chat.use), it keeps the shared chat WebSocket connection alive
// via useChatSocket (see hooks/useChatSocket.ts — one socket, shared by every subscriber)
// and surfaces a toast + an instant badge bump for new messages while the widget itself
// is closed or minimized, which previously went unnoticed until the next 60s poll.
import { useEffect, useRef, useState } from 'react'
import { Users } from 'lucide-react'
import { usePermissions } from '@/hooks'
import { useToast } from '@/components/ui/ToastContext'
import chatApi, { type ChatMessage } from '@/services/chatApi'
import { useChatWidgetStore } from '@/store/chatWidgetStore'
import useChatSocket, { type ChatSocketEvent } from '@/hooks/useChatSocket'
import { useAuthStore } from '@/store'

const POLL_MS = 60_000

export default function TeamChatFooterButton() {
  const { loaded, can } = usePermissions()
  const canUse = can('team_chat.use')
  const [unread, setUnread] = useState(0)
  const open = useChatWidgetStore((s) => s.open)
  const widgetState = useChatWidgetStore((s) => s.state)
  const widgetStateRef = useRef(widgetState)
  widgetStateRef.current = widgetState
  const { info } = useToast()
  const myId = useAuthStore((s) => s.user?.id)

  const refresh = () => chatApi.unreadCount().then(({ data }) => setUnread(data.count)).catch(() => {})

  useEffect(() => {
    if (!loaded || !canUse) return
    let alive = true
    const safeRefresh = () => { if (alive) refresh() }
    safeRefresh()
    const timer = window.setInterval(safeRefresh, POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [loaded, canUse])

  const handleEvent = (event: ChatSocketEvent) => {
    if (event.type !== 'message_new') return
    const msg = event.data as ChatMessage
    if (msg.sender_id === myId) return
    setUnread((n) => n + 1)
    // The widget being open doesn't necessarily mean this exact conversation is on
    // screen, but "not open at all" is the clear, cheap case worth a toast for.
    if (widgetStateRef.current === 'closed' || widgetStateRef.current === 'minimized') {
      info(msg.sender_name || 'New message', msg.content?.slice(0, 120) || 'Sent an attachment')
    }
  }

  useChatSocket(canUse ? handleEvent : () => {})

  if (!loaded || !canUse) return null

  return (
    <button type="button" className="tn-ftb" onClick={open} aria-label="Team Chat">
      <Users size={15} /><span>Team Chat</span>{unread > 0 && <em className="tn-badge" aria-label={`${unread} unread`}>{unread}</em>}
    </button>
  )
}
