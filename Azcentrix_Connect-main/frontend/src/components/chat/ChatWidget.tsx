// Floating Team Chat window, opened from the footer bar button — not a sidebar page.
// Window chrome mirrors a normal desktop window: minimize (collapse to a small bar),
// maximize/restore (toggle a near-fullscreen size), and close (cancel — hides the widget).
import { lazy, Suspense } from 'react'
import { Maximize2, Minimize2, Minus, Users, X } from 'lucide-react'
import { useChatWidgetStore } from '@/store/chatWidgetStore'
import '@/pages/chat/chat.css'

const TeamChatPage = lazy(() => import('@/pages/chat/TeamChatPage'))

export default function ChatWidget() {
  const { state, close, minimize, toggleMaximize, open } = useChatWidgetStore()
  if (state === 'closed') return null

  return (
    <div className={`chat-widget ${state}`} role="dialog" aria-label="Team Chat">
      <div className="chat-widget-head" onClick={() => state === 'minimized' && open()}>
        <Users size={15} />
        <b>Team Chat</b>
        <div className="chat-widget-head-actions">
          <button type="button" title="Minimize" onClick={(e) => { e.stopPropagation(); minimize() }}><Minus size={14} /></button>
          <button type="button" title={state === 'maximized' ? 'Restore' : 'Maximize'} onClick={(e) => { e.stopPropagation(); toggleMaximize() }}>
            {state === 'maximized' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button type="button" title="Close" onClick={(e) => { e.stopPropagation(); close() }}><X size={15} /></button>
        </div>
      </div>
      {state !== 'minimized' && (
        <div className="chat-widget-body">
          <Suspense fallback={<div className="chat-empty-hint">Loading…</div>}>
            <TeamChatPage />
          </Suspense>
        </div>
      )}
    </div>
  )
}
