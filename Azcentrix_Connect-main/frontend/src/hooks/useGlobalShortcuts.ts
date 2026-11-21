import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCrmHeaderPopStore } from '@/store/crmHeaderPopStore'
import { useFooterPanelStore } from '@/store/footerPanelStore'
import { useChatWidgetStore } from '@/store/chatWidgetStore'
import { useShortcutsModalStore } from '@/store/shortcutsModalStore'

// Tier 1 — app-wide shortcuts (mounted once in AppLayout.tsx). Ctrl+K is deliberately
// left alone: it already has its own listener in GlobalSearch.tsx and Ctrl+Shift+K
// reuses that same search as the "command palette" — this app has no separate command
// system to open instead. Esc is NOT handled globally here: every panel/drawer/dialog
// that needs it already closes itself on Escape locally (Modal.tsx, footer popovers,
// the chat message popups, etc.) — a second blanket handler here would just race them.
const NAV_SHORTCUTS: Record<string, string> = {
  h: '/dashboard',
  l: '/leads',
  u: '/customers',
  t: '/tenders',
  q: '/quotations',
  d: '/opportunities', // "Deals" in the sidebar — same route as Opportunities, see App.tsx
  w: '/workorders',
  p: '/approvals',
  b: '/document-management',
  s: '/settings',
  m: '/calendar',
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useGlobalShortcuts() {
  const navigate = useNavigate()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // "?" opens the shortcuts list, but only outside text inputs (Shift+/ is how "?" is typed).
      if (e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault()
        useShortcutsModalStore.getState().toggle()
        return
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        // "Command palette" — this app has no separate command system, so this just
        // opens the same global search Ctrl+K does (GlobalSearch.tsx owns its own
        // open state privately; its trigger button is the only reachable hook into it).
        e.preventDefault()
        const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Search (Ctrl+K)"]')
        trigger?.click()
        return
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const key = e.key.toLowerCase()
        if (key === 'a') { e.preventDefault(); useFooterPanelStore.getState().toggle('announcements'); return }
        if (key === 'r') { e.preventDefault(); useFooterPanelStore.getState().toggle('reminders'); return }
        if (key === 'c') { e.preventDefault(); useChatWidgetStore.getState().open(); return }
        const path = NAV_SHORTCUTS[key]
        if (path) { e.preventDefault(); navigate(path); return }
      }

      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        e.preventDefault()
        useCrmHeaderPopStore.getState().toggle('create')
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [navigate])
}

export default useGlobalShortcuts
