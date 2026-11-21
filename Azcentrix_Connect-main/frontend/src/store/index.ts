import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { clearPermissionCache } from '@/hooks/Usepermissions'
import { SessionPolicy, User, TenantTheme } from '@/types'
import { clearAuthStorage } from '@/utils/auth'

interface AuthStore {
  user: User | null
  access_token: string | null
  refresh_token: string | null
  permissions: string[]
  tenant_slug: string | null
  session_policy: SessionPolicy | null
  login: (data: {
    user: User
    access_token: string
    refresh_token: string
    permissions: string[]
    tenant_slug: string
    session_policy?: SessionPolicy | null
  }) => void
  updateSession: (data: {
    access_token: string
    refresh_token?: string | null
    session_policy?: SessionPolicy | null
  }) => void
  logout: () => void
  setUser: (user: User) => void
  hasPermission: (perm: string) => boolean
  isAtLeast: (role: string) => boolean
}

const ROLE_HIERARCHY = ['sales', 'support', 'accounts', 'manager', 'vp', 'ceo', 'admin']

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      access_token: null,
      refresh_token: null,
      permissions: [],
      tenant_slug: null,
      session_policy: null,

      login: (data) => {
        clearPermissionCache()
        set({
          user: data.user,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          permissions: data.permissions,
          tenant_slug: data.tenant_slug,
          session_policy: data.session_policy ?? null,
        })
        try {
          localStorage.setItem('access_token', data.access_token)
          localStorage.setItem('refresh_token', data.refresh_token)
          localStorage.setItem('tenant_slug', data.tenant_slug)
        } catch {
          // Zustand keeps the in-memory session active even if browser storage fails.
        }
      },

      updateSession: (data) => {
        const nextRefreshToken = data.refresh_token === undefined ? get().refresh_token : data.refresh_token
        set((state) => ({
          access_token: data.access_token,
          refresh_token: nextRefreshToken ?? null,
          session_policy: data.session_policy ?? state.session_policy,
        }))
        try {
          localStorage.setItem('access_token', data.access_token)
          if (nextRefreshToken) localStorage.setItem('refresh_token', nextRefreshToken)
          else localStorage.removeItem('refresh_token')
        } catch {
          // The active tab can continue with the in-memory token.
        }
      },

      logout: () => {
        clearPermissionCache()
        clearAuthStorage()
        set({
          user: null,
          access_token: null,
          refresh_token: null,
          permissions: [],
          tenant_slug: null,
          session_policy: null,
        })
      },

      setUser: (user) => set({ user }),

      hasPermission: (perm: string) => {
        const { permissions } = get()
        return permissions.includes('*') || permissions.includes(perm)
      },

      isAtLeast: (role: string) => {
        const { user } = get()
        if (!user) return false
        const userLevel = ROLE_HIERARCHY.indexOf(user.role)
        const requiredLevel = ROLE_HIERARCHY.indexOf(role)
        return userLevel >= requiredLevel
      },
    }),
    {
      name: 'digitcrm-auth',
      partialize: (state) => ({
        user: state.user,
        access_token: state.access_token,
        refresh_token: state.refresh_token,
        permissions: state.permissions,
        tenant_slug: state.tenant_slug,
        session_policy: state.session_policy,
      }),
    }
  )
)

interface ThemeStore {
  theme: TenantTheme
  setTheme: (theme: Partial<TenantTheme>) => void
  applyTheme: (primaryColor: string) => void
}

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return { r, g, b }
}

function lighten(hex: string, pct: number) {
  const { r, g, b } = hexToRgb(hex)
  const amt = Math.round(255 * pct)
  return `rgb(${Math.min(r + amt, 255)}, ${Math.min(g + amt, 255)}, ${Math.min(b + amt, 255)})`
}

function darken(hex: string, pct: number) {
  const { r, g, b } = hexToRgb(hex)
  const amt = Math.round(255 * pct)
  return `rgb(${Math.max(r - amt, 0)}, ${Math.max(g - amt, 0)}, ${Math.max(b - amt, 0)})`
}

export const useThemeStore = create<ThemeStore>()(
  persist(
    (set, get) => ({
      theme: {
        primary_color: '#0B1F3A',
        company_name: '',
        date_format: 'DD-MM-YYYY',
      },

      setTheme: (partial) => set((s) => ({ theme: { ...s.theme, ...partial } })),

      applyTheme: (primaryColor: string) => {
        const root = document.documentElement
        root.style.setProperty('--primary', primaryColor)
        root.style.setProperty('--primary-light', lighten(primaryColor, 0.1))
        root.style.setProperty('--primary-lighter', lighten(primaryColor, 0.2))
        root.style.setProperty('--primary-dark', darken(primaryColor, 0.05))
        root.style.setProperty('--sidebar-bg', primaryColor)
        get().setTheme({ primary_color: primaryColor })
      },
    }),
    { name: 'digitcrm-theme' }
  )
)

interface UIStore {
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (v: boolean) => void
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
    }),
    { name: 'digitcrm-ui' }
  )
)

interface NotifStore {
  unreadCount: number
  setUnreadCount: (n: number) => void
  decrementUnread: () => void
}

export const useNotifStore = create<NotifStore>()((set) => ({
  unreadCount: 0,
  setUnreadCount: (n) => set({ unreadCount: n }),
  decrementUnread: () => set((s) => ({ unreadCount: Math.max(0, s.unreadCount - 1) })),
}))
