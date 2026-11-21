import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { usePlatformAuthStore } from '@/store/platformAuthStore'
import PlatformSidebar from './PlatformSidebar'
import PlatformHeader from './PlatformHeader'
import { platformApi, PlatformConfig } from '@/services/platformApi'

const ENV_STYLES: Record<string, { bar: string; text: string; label: string }> = {
  DEVELOPMENT: {
    bar: 'bg-amber-500',
    text: 'text-amber-900',
    label: 'DEVELOPMENT',
  },
  STAGING: {
    bar: 'bg-blue-600',
    text: 'text-white',
    label: 'STAGING',
  },
  PRODUCTION: {
    bar: 'bg-transparent',
    text: '',
    label: '',
  },
}

function EnvBanner({ config }: { config: PlatformConfig | null }) {
  if (!config || config.environment === 'PRODUCTION') return null
  const style = ENV_STYLES[config.environment] || ENV_STYLES.DEVELOPMENT
  return (
    <div className={`${style.bar} px-4 py-1 text-center`}>
      <span className={`text-xs font-bold tracking-widest uppercase ${style.text}`}>
        {style.label} — {config.app_name} v{config.app_version}
      </span>
    </div>
  )
}

const THEME_KEY = 'platform-theme'
const SIDEBAR_KEY = 'platform-sidebar-collapsed'

function storedTheme(): 'light' | 'dark' {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' }
}

export default function PlatformLayout() {
  const [config, setConfig] = useState<PlatformConfig | null>(null)
  const [theme, setTheme] = useState(storedTheme)
  const toggleTheme = () => setTheme(current => {
    const next = current === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(THEME_KEY, next) } catch { /* Theme still applies for this visit. */ }
    return next
  })
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) === '1' } catch { return false } })
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  // Prototype data-a="sbc": collapse to the icon rail on desktop; on phones (always a rail) peek the full sidebar instead.
  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 700px)').matches) { setMobileMenuOpen(o => !o); return }
    setCollapsed(current => {
      try { localStorage.setItem(SIDEBAR_KEY, current ? '0' : '1') } catch { /* Still applies for this visit. */ }
      return !current
    })
  }
  const location = useLocation()
  const navigate = useNavigate()
  const logout = usePlatformAuthStore(state => state.logout)
  const token = usePlatformAuthStore(state => state.token)

  useEffect(() => {
    if (!token) return
    const activityKey = `platform_last_activity:${token.slice(-24)}`
    const policyKey = 'platform_session_timeout_minutes'
    let minutes = Number(localStorage.getItem(policyKey)) || 30
    let lastSent = 0
    let stopped = false
    let timer: number | undefined
    const signOut = () => {
      if (stopped) return
      stopped = true
      logout()
      navigate('/platform/login', { replace: true })
    }
    const schedule = () => {
      if (stopped) return
      if (timer !== undefined) window.clearTimeout(timer)
      const last = Number(localStorage.getItem(activityKey)) || Date.now()
      const remaining = last + minutes * 60000 - Date.now()
      if (remaining <= 0) { signOut(); return }
      timer = window.setTimeout(schedule, remaining)
    }
    const loadPolicy = () => platformApi.getSessionTimeout().then(({ data }) => {
      if (stopped) return
      minutes = data.timeout_minutes
      localStorage.setItem(policyKey, String(minutes))
      schedule()
    }).catch(() => {})
    const activity = (event: Event) => {
      if (!event.isTrusted || stopped) return
      const last = Number(localStorage.getItem(activityKey)) || 0
      if (last && Date.now() - last >= minutes * 60000) { signOut(); return }
      localStorage.setItem(activityKey, String(Date.now()))
      schedule()
      if (Date.now() - lastSent < 15000) return
      lastSent = Date.now()
      platformApi.sessionActivity().then(({ data }) => {
        if (stopped) return
        minutes = data.timeout_minutes
        localStorage.setItem(policyKey, String(minutes))
        schedule()
      }).catch(error => { if (error?.response?.status === 401) signOut() })
    }
    if (!localStorage.getItem(activityKey)) localStorage.setItem(activityKey, String(Date.now()))
    schedule()
    loadPolicy()
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
    events.forEach(name => window.addEventListener(name, activity, { passive: true }))
    window.addEventListener('platform-timeout-changed', loadPolicy)
    const storage = (event: StorageEvent) => {
      if (event.key === 'platform_token' && !event.newValue) signOut()
      else if (event.key === activityKey) schedule()
      else if (event.key === policyKey && event.newValue) { minutes = Number(event.newValue) || 30; schedule() }
    }
    const visibility = () => { if (document.visibilityState === 'visible') schedule() }
    window.addEventListener('storage', storage)
    document.addEventListener('visibilitychange', visibility)
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); events.forEach(name => window.removeEventListener(name, activity)); window.removeEventListener('platform-timeout-changed', loadPolicy); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', visibility) }
  }, [token, logout, navigate])

  // Auto-close mobile menu on navigation
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    platformApi.getConfig()
      .then(({ data }) => setConfig(data))
      .catch(() => {/* non-critical */})
  }, [])

  return (
    <div className={`platform-shell flex h-screen flex-col overflow-hidden ${collapsed ? 'sbc' : ''}`} data-theme={theme}>
      <EnvBanner config={config} />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {mobileMenuOpen && <div className="fixed inset-0 z-[15] bg-[rgba(8,14,22,.35)]" onClick={() => setMobileMenuOpen(false)} aria-hidden="true" />}

        <PlatformSidebar peek={mobileMenuOpen} onNavigate={() => setMobileMenuOpen(false)} version={config?.app_version} environment={config?.environment} />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <PlatformHeader environment={config?.environment} theme={theme} onToggleTheme={toggleTheme} onToggleSidebar={toggleSidebar} />
          <main className="flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  )
}
