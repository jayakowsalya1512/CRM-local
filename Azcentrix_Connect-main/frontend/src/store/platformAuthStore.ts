import { create } from 'zustand'
import { PLATFORM_TOKEN_KEY, PLATFORM_USER_KEY } from '@/services/platformApi'

type PlatformUser = {
  full_name: string
  username?: string
  role: 'super_admin'
}

type PlatformAuthState = {
  token: string | null
  user: PlatformUser | null
  login: (token: string, user: PlatformUser) => void
  logout: () => void
  isAuthenticated: () => boolean
}

function loadUser(): PlatformUser | null {
  try {
    const raw = localStorage.getItem(PLATFORM_USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export const usePlatformAuthStore = create<PlatformAuthState>((set, get) => ({
  token: localStorage.getItem(PLATFORM_TOKEN_KEY),
  user: loadUser(),

  login: (token, user) => {
    localStorage.setItem(PLATFORM_TOKEN_KEY, token)
    localStorage.setItem(PLATFORM_USER_KEY, JSON.stringify(user))
    set({ token, user })
  },

  logout: () => {
    localStorage.removeItem(PLATFORM_TOKEN_KEY)
    localStorage.removeItem(PLATFORM_USER_KEY)
    set({ token: null, user: null })
  },

  isAuthenticated: () => Boolean(get().token && get().user?.role === 'super_admin'),
}))
