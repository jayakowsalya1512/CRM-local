// "Recently opened" records — prototype v17's RECENT array / recentAdd(), rebuilt for
// this app as a per-user localStorage list (there is no server-side equivalent). Nothing
// wires itself in automatically: call recordRecentItem(...) from a record's own load effect.
// Currently wired into Customer360Page and LeadDrawer — extend the same way per module.
import { create } from 'zustand'
import { useAuthStore } from '@/store'

export type RecentItem = { module: string; label: string; path: string; at: string }

const MAX_ITEMS = 12

function storageKey(): string | null {
  const { tenant_slug, user } = useAuthStore.getState()
  if (!tenant_slug || !user?.id) return null
  return `crm_recent_items:${tenant_slug}:${user.id}`
}

function load(): RecentItem[] {
  const key = storageKey()
  if (!key) return []
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function save(items: RecentItem[]) {
  const key = storageKey()
  if (!key) return
  try { localStorage.setItem(key, JSON.stringify(items)) } catch { /* ignore quota errors */ }
}

interface RecentItemsStore {
  items: RecentItem[]
  add: (item: Omit<RecentItem, 'at'>) => void
  clear: () => void
  refresh: () => void
}

export const useRecentItemsStore = create<RecentItemsStore>((set) => ({
  items: load(),
  add: (item) => set((s) => {
    const next = [{ ...item, at: new Date().toISOString() }, ...s.items.filter((x) => x.path !== item.path)].slice(0, MAX_ITEMS)
    save(next)
    return { items: next }
  }),
  clear: () => { save([]); set({ items: [] }) },
  refresh: () => set({ items: load() }),
}))

export function recordRecentItem(item: Omit<RecentItem, 'at'>) {
  useRecentItemsStore.getState().add(item)
}
