import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import api, { withPassiveSessionActivity } from '@/services/api'

// Announcements for the signed-in tenant user (Bidwise prototype v9: footer Announcements panel + dashboard
// banner). The feed merges platform-broadcast posts ("p-<id>") with posts made inside this tenant
// ("t-<id>", gated by the "announcements.create" / "announcements.delete" permissions). The server
// returns only live posts (schedule arrived, not expired, visible to the caller's role); reads are per user.
export type TenantAnnouncement = { id: string; title: string; message: string; type: 'Info' | 'Important' | 'Maintenance'; posted_at: string; posted_by: string; until: string | null; read: boolean }
export type NewAnnouncement = { title: string; message: string; type: TenantAnnouncement['type']; scheduled_at?: string | null; until?: string | null; roles?: string[] | null }

type Ctx = { items: TenantAnnouncement[]; unread: number; markRead: (id: string) => void; markAllRead: () => void; refresh: () => void; post: (body: NewAnnouncement) => Promise<{ id: string; scheduled: boolean }> }
const AnnouncementsCtx = createContext<Ctx>({ items: [], unread: 0, markRead: () => {}, markAllRead: () => {}, refresh: () => {}, post: () => Promise.reject(new Error('not ready')) })
const POLL_MS = 5 * 60_000

export function AnnouncementsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<TenantAnnouncement[]>([])
  const alive = useRef(true)
  const refresh = useCallback(() => {
    // Passive: background polling must not keep an idle session alive.
    api.get<{ items: TenantAnnouncement[] }>('/announcements', withPassiveSessionActivity())
      .then(({ data }) => { if (alive.current) setItems(data.items) })
      .catch(() => { /* announcements are optional; the app works without them */ })
  }, [])
  useEffect(() => {
    alive.current = true
    refresh()
    const timer = window.setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [refresh])

  const markRead = useCallback((id: string) => {
    setItems(list => list.map(a => a.id === id ? { ...a, read: true } : a))
    api.post(`/announcements/${id}/read`).catch(() => refresh())
  }, [refresh])
  const markAllRead = useCallback(() => {
    setItems(list => list.map(a => ({ ...a, read: true })))
    api.post('/announcements/read-all').catch(() => refresh())
  }, [refresh])
  const post = useCallback(async (body: NewAnnouncement) => {
    const { data } = await api.post<{ id: string; scheduled: boolean }>('/announcements', body)
    refresh()
    return data
  }, [refresh])

  const value = useMemo(() => ({ items, unread: items.filter(a => !a.read).length, markRead, markAllRead, refresh, post }), [items, markRead, markAllRead, refresh, post])
  return <AnnouncementsCtx.Provider value={value}>{children}</AnnouncementsCtx.Provider>
}

export const useAnnouncements = () => useContext(AnnouncementsCtx)
