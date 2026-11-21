/**
 * notifStore.ts — tiny shared notification state
 *
 * Both Header (bell dropdown) and NotificationsPage import this.
 * When either marks a notification read, the other reflects it instantly
 * without any polling delay.
 *
 * Usage:
 *   import { useNotifStore } from '@/store/notifStore'
 *   const { unread, refresh, markRead, markAll } = useNotifStore()
 */
import { create } from 'zustand'
import api, { withPassiveSessionActivity } from '@/services/api'

interface NotifState {
  unread:    number
  lastFetch: number        // timestamp — prevents redundant back-to-back fetches

  setUnread:  (n: number) => void
  refresh:    () => Promise<void>   // fetch fresh unread count from server
  markRead:   () => void             // optimistic decrement
  markAll:    () => void            // optimistic zero
}

export const useNotifStore = create<NotifState>((set, get) => ({
  unread:    0,
  lastFetch: 0,

  setUnread: (n) => set({ unread: n }),

  refresh: async () => {
    // Throttle: skip if fetched within the last 5 s
    if (Date.now() - get().lastFetch < 5000) return
    try {
      const r = await api.get('/notifications/unread-count', withPassiveSessionActivity({}))
      set({ unread: r.data?.unread_count ?? 0, lastFetch: Date.now() })
    } catch {}
  },

  markRead: () =>
    set(s => ({ unread: Math.max(0, s.unread - 1) })),

  markAll: () =>
    set({ unread: 0 }),
}))
