import { useState, useEffect, useRef } from 'react'
import {
  Bell, ChevronDown, Settings, LogOut, Search, User, CircleHelp,
  ShieldCheck, Crown, Users, TrendingUp, Calculator, Headphones,
  Shield, Star, Briefcase, CheckCheck, Check, Clock, ChevronLeft, ChevronRight,
  CheckCircle, XCircle, AlertTriangle, Info, ArrowRight, Menu,
  type LucideIcon,
} from 'lucide-react'
import GlobalSearch from '@/components/layout/GlobalSearch'
import StickyNotes from '@/components/layout/StickyNotes'
import HelpSupport from '@/components/layout/HelpSupport'
import QuickTour from '@/components/layout/QuickTour'
import { useAuthStore }       from '@/store'
import { useNotifStore }      from '@/store/notifStore'
import { clearPermissionCache } from '@/hooks/Usepermissions'
import { formatRoleDisplayName, usePermissions } from '@/hooks'
import api, { authApi }       from '@/services/api'
import { useModuleName }      from '@/context/ModuleLabelsContext'
import { useToast }           from '@/components/ui/ToastContext'
import { useNavigate }        from 'react-router-dom'

const ICON_MAP: Record<string, LucideIcon> = {
  ShieldCheck, Crown, Users, TrendingUp, Calculator,
  Headphones, Shield, Star, Briefcase, User,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60)     return 'Just now'
  if (s < 3600)   return `${Math.floor(s / 60)}m ago`
  if (s < 86400)  return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

type NMeta = { icon: React.ReactNode; iconBg: string; iconColor: string; dot: string }

function getNMeta(action = ''): NMeta {
  if (action.includes('approved'))
    return { icon: <CheckCircle size={13} />, iconBg: 'bg-green-50',  iconColor: 'text-green-600', dot: 'bg-green-500'  }
  if (action.includes('rejected'))
    return { icon: <XCircle size={13} />,     iconBg: 'bg-red-50',    iconColor: 'text-red-500',   dot: 'bg-red-500'    }
  if (action.includes('request') || action.includes('approval'))
    return { icon: <Clock size={13} />,       iconBg: 'bg-amber-50',  iconColor: 'text-amber-600', dot: 'bg-amber-500'  }
  if (action.includes('warn') || action.includes('alert'))
    return { icon: <AlertTriangle size={13} />, iconBg: 'bg-orange-50', iconColor: 'text-orange-500', dot: 'bg-orange-500' }
  return   { icon: <Info size={13} />,        iconBg: 'bg-blue-50',   iconColor: 'text-blue-500',  dot: 'bg-blue-500'   }
}

// ─── RoleBadge ────────────────────────────────────────────────────────────────

function RoleBadge({ icon: iconName, label, color, size = 'sm' }: {
  icon?: string | null; label: string; color?: string | null; size?: 'sm' | 'md'
}) {
  const Icon     = (iconName && ICON_MAP[iconName]) ? ICON_MAP[iconName] : ShieldCheck
  const hex      = color || '#2563eb'
  const iconSize = size === 'sm' ? 10 : 12
  const textSize = size === 'sm' ? '10px' : '11px'
  const padding  = size === 'sm' ? '2px 6px' : '3px 8px'
  return (
    <span className="inline-flex items-center gap-1 font-semibold rounded-md"
      style={{ fontSize: textSize, padding, color: hex, backgroundColor: `${hex}18` }}>
      <Icon size={iconSize} className="flex-shrink-0" />
      <span>{label}</span>
    </span>
  )
}

// ─── Bell Dropdown ────────────────────────────────────────────────────────────

function NotifDropdown({ onClose }: { onClose: () => void }) {
  const navigate                          = useNavigate()
  const { markRead: storeMarkRead,
          markAll:  storeMarkAll,
          refresh,
          setUnread }                     = useNotifStore()
  const [items,   setItems]               = useState<any[]>([])
  const [unreadCount, setUnreadCount]      = useState(0)
  const [loading, setLoading]             = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const r = await api.get('/notifications?unread_only=true&mine_only=true&limit=8')
        const list = Array.isArray(r.data) ? r.data : r.data.items ?? []
        setItems(list)
        // Sync badge with the authoritative count returned by this same request
        if (typeof r.data?.unread_count === 'number') {
          setUnreadCount(r.data.unread_count)
          setUnread(r.data.unread_count)
        } else {
          setUnreadCount(list.length)
        }
      } catch {}
      finally { setLoading(false) }
    })()
  }, [])

  const handleMarkRead = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    setItems(prev => prev.filter(n => n.id !== id))
    storeMarkRead()
    setUnreadCount(prev => Math.max(0, prev - 1))
    try {
      const r = await api.put(`/notifications/${id}/read`)
      if (typeof r.data?.unread_count === 'number') {
        setUnreadCount(r.data.unread_count)
        setUnread(r.data.unread_count)
      }
    }
    catch { refresh() }
  }

  const handleMarkAll = async () => {
    setItems([])
    storeMarkAll()
    setUnreadCount(0)
    try { await api.put('/notifications/mark-all-read') }
    catch { refresh() }
  }

  const goAll = () => { navigate('/notifications'); onClose() }

  return (
    <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 max-w-[calc(100vw-1rem)]
      bg-white border border-gray-100 rounded-2xl shadow-xl shadow-gray-200/80 z-[70] overflow-hidden">

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
        <Bell size={15} className="text-gray-700" />
        <span className="text-sm font-bold text-gray-800">Notifications</span>
        {unreadCount > 0 && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full text-white"
            style={{ background: 'var(--color-danger, #ef4444)' }}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </div>

      {/* List */}
      <div className="max-h-80 overflow-y-auto">
        {loading ? (
          [1, 2, 3].map(i => (
            <div key={i} className="flex items-start gap-3 px-4 py-3 border-b border-gray-50">
              <div className="w-8 h-8 rounded-xl bg-gray-100 animate-pulse flex-shrink-0" />
              <div className="flex-1 space-y-1.5 py-0.5">
                <div className="h-3 bg-gray-100 rounded animate-pulse w-36" />
                <div className="h-2.5 bg-gray-100 rounded animate-pulse w-full" />
              </div>
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 px-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center
              justify-center mb-3">
              <Bell size={20} className="text-gray-300" />
            </div>
            <p className="text-sm font-semibold text-gray-600">You're all caught up!</p>
            <p className="text-xs text-gray-400 mt-0.5">No unread notifications</p>
          </div>
        ) : (
          items.map(n => {
            const meta = getNMeta(n.action)
            return (
              <button key={n.id} onClick={goAll}
                className="w-full flex items-start gap-3 px-4 py-3 border-b border-gray-50
                  last:border-0 hover:bg-gray-50 transition-colors text-left group">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center
                  flex-shrink-0 mt-0.5 ${meta.iconBg} ${meta.iconColor}`}>
                  {meta.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-gray-800 leading-snug truncate">
                    {n.title}
                  </p>
                  <p className="text-[11px] text-gray-500 mt-0.5 leading-relaxed line-clamp-2">
                    {n.message}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-1">{timeAgo(n.created_at)}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  <div className={`w-2 h-2 rounded-full ${meta.dot} mt-1`} />
                  <button
                    onClick={e => handleMarkRead(e, n.id)}
                    title="Mark as read"
                    className="opacity-0 group-hover:opacity-100 transition-opacity
                      w-6 h-6 rounded-lg border border-gray-200 bg-white
                      flex items-center justify-center
                      text-gray-400 hover:text-green-600 hover:border-green-200">
                    <Check size={10} />
                  </button>
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-gray-100 px-4 py-2.5 flex items-center justify-between gap-2">
        {items.length > 0 ? (
          <button onClick={handleMarkAll}
            className="flex items-center gap-1 text-[11px] font-medium text-gray-400
              hover:text-gray-700 transition-colors">
            <CheckCheck size={11} /> Mark all read
          </button>
        ) : <span />}
        <button onClick={goAll}
          className="flex items-center gap-1.5 text-xs font-semibold transition-colors"
          style={{ color: 'var(--color-accent)' }}>
          View all <ArrowRight size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── Header ───────────────────────────────────────────────────────────────────

export default function Header({
  collapsed,
  onToggle,
  onMobileMenuToggle,
  toggleMode = 'sidebar',
}: {
  collapsed: boolean
  onToggle: () => void
  onMobileMenuToggle?: () => void
  toggleMode?: 'sidebar' | 'back'
}) {
  const { label: notifLabel } = useModuleName('notifications')
  const { user, logout, setUser }            = useAuthStore() as any
  const tenantSlug = useAuthStore(state => state.tenant_slug)
  const { roleIcon, roleColor, roleDisplay, can } = usePermissions() as any
  const { unread, refresh }                  = useNotifStore()
  const { success, error: showError }        = useToast()
  const [bellOpen, setBellOpen]              = useState(false)
  const [helpOpen, setHelpOpen]              = useState(false)
  const [tourOpen, setTourOpen]              = useState(false)
  const [menuOpen, setMenuOpen]              = useState(false)
  const [signingOut, setSigningOut]          = useState(false)
  const [loggingOutAllDevices, setLoggingOutAllDevices] = useState(false)
  const menuRef                              = useRef<HTMLDivElement>(null)
  const bellRef                              = useRef<HTMLDivElement>(null)
  const helpRef                              = useRef<HTMLDivElement>(null)
  const navigate                             = useNavigate()

  const roleLabel   = roleDisplay || formatRoleDisplayName(user?.role)
  const initials    = user?.full_name?.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase() ?? '?'
  const avatarStyle = { backgroundColor: roleColor || 'var(--color-accent)' }
  const toggleLabel = toggleMode === 'back'
    ? 'Back to leads'
    : collapsed
      ? 'Expand sidebar'
      : 'Collapse sidebar'

  // Close on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false)
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) setHelpOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // Initial load + poll every 30 s
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!user?.id) return

    let active = true
    authApi.me()
      .then(response => {
        if (active && response.data) setUser(response.data)
      })
      .catch(() => {})

    return () => {
      active = false
    }
  }, [user?.id, setUser])

  const handleSignOut = async () => {
    setSigningOut(true)
    try {
      await authApi.logout()
    } catch {}
    finally {
      clearPermissionCache()
      logout()
      setMenuOpen(false)
      setSigningOut(false)
    }
  }

  const handleLogoutAllDevices = async () => {
    const { confirmAction } = await import('@/utils/sweetAlert')
    const confirmed = await confirmAction({
      title: 'Logout All Devices?',
      text: 'This will sign out your other active devices. This device will stay signed in.',
      confirmButtonText: 'Logout All Devices',
    })
    if (!confirmed) return

    setLoggingOutAllDevices(true)
    try {
      const response = await authApi.logoutAllMyDevices()
      success(response.data?.message || 'Logged out other active devices')
      setMenuOpen(false)
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to log out all devices')
    } finally {
      setLoggingOutAllDevices(false)
    }
  }

  const showHelpMessage = (message: string) => {
    success(message)
    setHelpOpen(false)
  }

  const btnStyle = {
    color: 'var(--color-primary)',
    background: 'rgba(255,255,255,0.96)',
    border: '1px solid rgba(255,255,255,0.72)',
    boxShadow: '0 1px 4px rgba(15,23,42,0.10)',
  }
  const btnHoverOn  = (e: React.MouseEvent<HTMLButtonElement>) => {
    (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.88)'
    ;(e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)'
  }
  const btnHoverOff = (e: React.MouseEvent<HTMLButtonElement>) => {
    (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.96)'
    ;(e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.72)'
  }

  return (
    <header
      className="h-14 w-full flex items-center justify-between px-3 sm:px-5 flex-shrink-0 z-[60] sticky top-0 isolate"
      style={{
        background: 'linear-gradient(120deg, var(--color-primary) 0%, var(--color-secondary) 58%, var(--color-accent) 100%)',
        boxShadow: '0 2px 12px rgba(15,23,42,0.18)',
      }}
    >
      {/* Left side — toggle buttons */}
      <div className="flex items-center">
        {/* Mobile hamburger — visible only on mobile, opens drawer */}
        <button
          onClick={onMobileMenuToggle}
          className="md:hidden p-2 rounded-xl transition-all duration-200 mr-1"
          style={btnStyle}
          onMouseEnter={btnHoverOn}
          onMouseLeave={btnHoverOff}
          aria-label="Open navigation menu"
        >
          <Menu size={18} />
        </button>

        {/* Desktop sidebar toggle — hidden on mobile */}
        <button
          onClick={onToggle}
          className="hidden md:flex p-1.5 rounded-lg transition-all duration-200 mr-2"
          style={btnStyle}
          onMouseEnter={btnHoverOn}
          onMouseLeave={btnHoverOff}
          aria-label={toggleLabel}
          title={toggleLabel}
        >
          {toggleMode === 'back'
            ? <ChevronLeft size={18} />
            : collapsed
              ? <ChevronRight size={18} />
              : <ChevronLeft size={18} />}
        </button>
      </div>

      {/* Right side — actions */}
      <div className="flex items-center gap-1 sm:gap-1.5">
        {/* Global Search */}
        <GlobalSearch />

        <div className="w-px h-6 mx-0.5 sm:mx-1" style={{ background: 'rgba(255,255,255,0.28)' }} />
        {user?.id && <StickyNotes key={`${tenantSlug}:${user.id}`} onOpen={() => { setBellOpen(false); setHelpOpen(false); setMenuOpen(false) }} />}

        <div className="w-px h-6 mx-0.5 sm:mx-1" style={{ background: 'rgba(255,255,255,0.28)' }} />

        {/* Help & support */}
        <div className="relative" ref={helpRef}>
          <button
            onClick={() => { setHelpOpen(open => !open); setBellOpen(false); setMenuOpen(false) }}
            className="relative p-2 rounded-xl transition-all"
            style={{ color: '#fff', background: helpOpen ? 'rgba(255,255,255,0.16)' : 'transparent' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.14)'}
            onMouseLeave={e => { if (!helpOpen) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            aria-label="Open help and support"
            aria-expanded={helpOpen}
          >
            <CircleHelp size={19} />
          </button>
          <HelpSupport
            open={helpOpen}
            userName={user?.full_name}
            onClose={() => setHelpOpen(false)}
            onQuickTour={() => { setHelpOpen(false); setTourOpen(true) }}
            onDocumentLibrary={() => { navigate('/document-management'); setHelpOpen(false) }}
            onVideoTutorials={() => showHelpMessage('Video tutorials will be available here soon.')}
            onReportIssue={() => { window.location.href = 'mailto:support@azcentrix.com?subject=Azcentrix%20Connect%20Issue%20Report'; setHelpOpen(false) }}
            onAiAssistant={() => showHelpMessage('The AI Help Assistant will be available here soon.')}
            onContactSupport={() => { window.location.href = 'mailto:support@azcentrix.com'; setHelpOpen(false) }}
            onAskAssistant={(question) => showHelpMessage(`AI Help Assistant: We received your question: “${question}”`)}
          />
        </div>

        <div className="w-px h-6 mx-0.5 sm:mx-1" style={{ background: 'rgba(255,255,255,0.28)' }} />

        {/* Bell */}
        <div className="relative" ref={bellRef}>
          <button
            onClick={() => { setBellOpen(o => !o); setHelpOpen(false); setMenuOpen(false) }}
            className="relative p-2 rounded-xl transition-all"
            style={{ color: '#fff' }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.14)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
          >
            <Bell size={18} />
            {unread > 0 && (
              <span className="absolute top-1.5 right-1.5 w-3.5 h-3.5 text-white
                text-[9px] font-bold rounded-full flex items-center justify-center leading-none"
                style={{ background: '#ef4444' }}>
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
          {bellOpen && <NotifDropdown onClose={() => setBellOpen(false)} />}
        </div>

        {/* Divider */}
        <div className="w-px h-6 mx-0.5 sm:mx-1" style={{ background: 'rgba(255,255,255,0.28)' }} />

        {/* User menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => { setMenuOpen(m => !m); setBellOpen(false); setHelpOpen(false) }}
            className="flex items-center gap-2 pl-1.5 sm:pl-2 pr-2 sm:pr-3 py-1.5 rounded-xl border transition-all"
            style={{ borderColor: 'transparent' }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.14)'
              ;(e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.32)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = 'transparent'
              ;(e.currentTarget as HTMLElement).style.borderColor = 'transparent'
            }}
          >
            {/* Avatar — always visible */}
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center
                text-white text-xs font-bold flex-shrink-0 shadow-sm"
              style={avatarStyle}
            >
              {initials}
            </div>
            {/* Name + role — hidden on mobile, visible sm+ */}
            <div className="hidden sm:block text-left">
              <p className="text-xs font-semibold leading-tight" style={{ color: '#fff' }}>
                {user?.full_name}
              </p>
              <RoleBadge icon={roleIcon} label={roleLabel} color="#ffffff" size="sm" />
            </div>
            <ChevronDown
              size={13}
              style={{ color: 'rgba(255,255,255,0.78)' }}
              className={`hidden sm:block transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 sm:w-60 max-w-[calc(100vw-1rem)]
              bg-white border border-gray-100 rounded-2xl shadow-xl shadow-gray-200/80 z-[70] overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center
                      text-white text-sm font-bold flex-shrink-0"
                    style={avatarStyle}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">{user?.full_name}</p>
                    <p className="text-xs text-gray-400 truncate">{user?.email}</p>
                  </div>
                </div>
                <div className="mt-2.5">
                  <RoleBadge icon={roleIcon} label={roleLabel} color={roleColor} size="md" />
                </div>
              </div>
              <div className="py-1">
                <button
                  onClick={() => { navigate('/settings/profile'); setMenuOpen(false) }}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm
                    text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <User size={14} className="text-gray-400" /> My Profile
                </button>
                {can('settings.view') && (
                  <button
                    onClick={() => { navigate('/settings'); setMenuOpen(false) }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-sm
                      text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <Settings size={14} className="text-gray-400" /> Settings
                  </button>
                )}
                <button
                  onClick={handleLogoutAllDevices}
                  disabled={loggingOutAllDevices}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm
                    text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <LogOut size={14} className="text-amber-500" />
                  {loggingOutAllDevices ? 'Logging Out Devices...' : 'Logout All My Devices'}
                </button>
              </div>
              <div className="border-t border-gray-100 py-1">
                <button
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm
                    text-red-600 hover:bg-red-50 transition-colors font-medium disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <LogOut size={14} /> {signingOut ? 'Signing Out...' : 'Sign Out'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <QuickTour open={tourOpen} userName={user?.full_name} onClose={() => setTourOpen(false)} />
    </header>
  )
}
