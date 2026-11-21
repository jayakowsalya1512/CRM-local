import { useState, useEffect, type CSSProperties } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import SessionTimeoutModal from '@/components/auth/SessionTimeoutModal'
import useSessionTimeout from '@/hooks/useSessionTimeout'
import Sidebar from './Sidebar'
import CrmHeader from '@/components/crm/CrmHeader'
import { useThemeStore, useUIStore } from '@/store'
import { ModuleLabelsProvider } from '@/context/ModuleLabelsContext'
import { AnnouncementsProvider } from '@/components/announcements/AnnouncementsContext'
import AnnouncementsFooter from '@/components/announcements/AnnouncementsFooter'
import ChatWidget from '@/components/chat/ChatWidget'
import ShortcutsModal from '@/components/layout/ShortcutsModal'
import useGlobalShortcuts from '@/hooks/useGlobalShortcuts'
import { useShortcutsModalStore } from '@/store/shortcutsModalStore'
import '@/styles/crm-shell.css'
import '@/styles/crm-app.css'

// Bidwise prototype v9 theme (application mode) on the existing shell: the sidebar, modules and footer are unchanged and restyled.
// Light / dark is per browser; the accent follows the tenant brand colour when it is usable as an accent.
const THEME_KEY = 'crm-theme'
const DEFAULT_ACCENT = '#0F6E8C'
const usableAccent = (hex?: string) => {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex) || hex.toUpperCase() === '#0B1F3A') return DEFAULT_ACCENT
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  // Too dark to read on the navy sidebar, or too light for white button text: keep the prototype teal.
  return lum < 0.08 || lum > 0.62 ? DEFAULT_ACCENT : hex
}

export default function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const canvasBasePath = location.pathname.startsWith('/opportunities') ? '/opportunities' : '/leads'
  const isLeadsCanvasPage =
    location.pathname === '/leads/pipeline' ||
    location.pathname === '/leads/new' ||
    /^\/leads\/[^/]+\/edit$/.test(location.pathname) ||
    location.pathname === '/opportunities/pipeline'
  const isSettingsPage = location.pathname.startsWith('/settings/advanced')   // the v17 /settings page scrolls with <main>
  const isReportDetailPage = /^\/reports\/[^/]+$/.test(location.pathname)
  const isReportsListPage = location.pathname === '/reports'
  const isQuestionnaireCustomerPage = /^\/questionnaire\/[^/]+$/.test(location.pathname)
  const isQuestionnaireViewPage = isQuestionnaireCustomerPage && new URLSearchParams(location.search).get('mode') !== 'edit'

  useGlobalShortcuts()
  const showShortcuts = useShortcutsModalStore((s) => s.open)
  const closeShortcuts = useShortcutsModalStore((s) => s.close)
  const { sidebarCollapsed, toggleSidebar, setSidebarCollapsed } = useUIStore()
  const collapsed = isLeadsCanvasPage ? true : sidebarCollapsed
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light' } catch { return 'light' } })
  const brand = useThemeStore(s => s.theme.primary_color)

  const toggleTheme = () => setTheme(t => {
    const next = t === 'dark' ? 'light' : 'dark'
    try { localStorage.setItem(THEME_KEY, next) } catch { /* applies for this visit */ }
    return next
  })
  // Desktop collapses the sidebar to its icon rail; below md the sidebar is a drawer the button opens.
  const onToggle = () => {
    if (isLeadsCanvasPage) return navigate(canvasBasePath)
    if (window.matchMedia('(max-width: 767px)').matches) return setMobileMenuOpen(o => !o)
    toggleSidebar()
  }

  // Auto-collapse the sidebar when opening a report, expand it again back on the Reports list
  useEffect(() => {
    if (isReportDetailPage) setSidebarCollapsed(true)
    else if (isReportsListPage) setSidebarCollapsed(false)
  }, [isReportDetailPage, isReportsListPage, setSidebarCollapsed])

  // Auto-collapse the sidebar when viewing a customer's questionnaire responses, expand again once you leave
  useEffect(() => {
    setSidebarCollapsed(isQuestionnaireViewPage)
  }, [isQuestionnaireViewPage, setSidebarCollapsed])

  useEffect(() => { setMobileMenuOpen(false) }, [location.pathname])

  const { warningOpen, countdownSeconds, stayingLoggedIn, stayLoggedIn, logoutNow } = useSessionTimeout()

  useEffect(() => {
    // Prototype v17 rail: 232px expanded, 64px collapsed (styles/crm-app.css); overlays align to it.
    document.documentElement.style.setProperty('--sidebar-w', collapsed ? '64px' : '232px')
  }, [collapsed])

  return (
    <ModuleLabelsProvider>
    <AnnouncementsProvider>
    <div className={`crm-shell flex h-screen flex-col overflow-hidden ${collapsed ? 'sbc' : ''}`} data-theme={theme} style={{ '--crm-ac': usableAccent(brand) } as CSSProperties}>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {mobileMenuOpen && <div className="fixed inset-0 z-[90] bg-[rgba(8,14,22,.35)] md:hidden" onClick={() => setMobileMenuOpen(false)} aria-hidden="true" />}
        <Sidebar collapsed={collapsed} mobileOpen={mobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <CrmHeader theme={theme} onToggleTheme={toggleTheme} onToggleSidebar={onToggle} toggleTitle={isLeadsCanvasPage ? 'Back to leads' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'} />
          <main className={`min-h-0 min-w-0 flex-1 ${isSettingsPage ? 'overflow-hidden' : isLeadsCanvasPage ? 'overflow-y-auto' : 'overflow-y-auto overflow-x-hidden'} ${isLeadsCanvasPage ? 'crm-pipeline-route-shell' : ''}`}>
            <Outlet />
          </main>
          <AnnouncementsFooter />
          <ChatWidget />
          {showShortcuts && <ShortcutsModal onClose={closeShortcuts} />}
        </div>
      </div>
      <SessionTimeoutModal
        open={warningOpen}
        countdownSeconds={countdownSeconds}
        stayingLoggedIn={stayingLoggedIn}
        onStayLoggedIn={() => { void stayLoggedIn() }}
        onLogout={() => { void logoutNow() }}
      />
    </div>
    </AnnouncementsProvider>
    </ModuleLabelsProvider>
  )
}
