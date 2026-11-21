import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePlatformAuthStore } from '@/store/platformAuthStore'
import { platformApi } from '@/services/platformApi'
import NewTenantModal from './NewTenantModal'
import { usePlatformAccess } from './usePlatformAccess'
import { Avatar, Ic } from './bw'

export default function PlatformHeader({ environment, theme, onToggleTheme, onToggleSidebar }: {
  environment?: string
  theme?: 'light' | 'dark'
  onToggleTheme?: () => void
  onToggleSidebar?: () => void
}) {
  const navigate = useNavigate()
  const { user, logout } = usePlatformAuthStore()
  const { me } = usePlatformAccess()
  const pending = me?.pending_approvals ?? 0
  const [open, setOpen] = useState(false)
  const [newTenant, setNewTenant] = useState(false)
  const [email, setEmail] = useState('')

  useEffect(() => {
    let active = true
    platformApi.me().then(({ data }) => { if (active) setEmail(data.email) }).catch(() => {})
    return () => { active = false }
  }, [])
  const menuRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLDivElement>(null)
  const [bellOpen, setBellOpen] = useState(false)
  const [query, setQuery] = useState('')
  const envName = (environment || (import.meta.env.PROD ? 'PRODUCTION' : 'DEVELOPMENT')).toUpperCase()
  const isProduction = envName === 'PRODUCTION'
  const name = user?.full_name || user?.username || 'Platform staff'

  const onSearch = (event: FormEvent) => {
    event.preventDefault()
    const term = query.trim()
    navigate(term ? `/platform/tenants?search=${encodeURIComponent(term)}` : '/platform/tenants')
  }

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
      if (!bellRef.current?.contains(event.target as Node)) setBellOpen(false)
    }
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); setBellOpen(false) }
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [])

  const onLogout = async () => {
    try { await platformApi.logout() } catch { /* Always allow local sign out. */ }
    logout()
    navigate('/platform/login', { replace: true })
  }

  // Prototype platPaint() top bar: sidebar toggle, search, environment pill, New tenant, alerts and the account menu.
  return (
    <header className="platform-top">
      <button type="button" onClick={onToggleSidebar} className="ib" aria-label="Toggle sidebar" title="Toggle sidebar">
        <Ic n="menu" />
      </button>

      <form onSubmit={onSearch} role="search" className="sr">
        <Ic n="search" />
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Find tenant by name or slug…"
          aria-label="Search tenants"
        />
      </form>

      <span
        className="envs flex-none whitespace-nowrap rounded-[9px] px-[9px] py-px text-[11px] font-semibold leading-[18px]"
        style={isProduction
          ? { color: 'var(--bw-ac)', background: 'color-mix(in srgb, var(--bw-ac) 12%, var(--bw-sf))' }
          : { color: 'var(--bw-wa)', background: 'color-mix(in srgb, var(--bw-wa) 15%, var(--bw-sf))' }}
      >
        {envName.charAt(0) + envName.slice(1).toLowerCase()}
      </span>

      <span className="flex-1" />

      {newTenant && <NewTenantModal onClose={() => setNewTenant(false)} />}
      <button type="button" onClick={() => setNewTenant(true)} className="bw-btn p s flex-none" title="New tenant">
        <Ic n="plus" /><span className="hidden sm:inline">New tenant</span>
      </button>

      <div ref={bellRef} className="relative">
        <button type="button" onClick={() => setBellOpen(value => !value)} aria-expanded={bellOpen} aria-label={pending ? `Alerts, ${pending} waiting` : 'Alerts'} title="Alerts" className="ib">
          <Ic n="bell" />
          {pending > 0 && <span className="dot">{pending > 99 ? '99+' : pending}</span>}
        </button>
        {bellOpen && (
          <div className="pop min-w-[260px]">
            <div className="border-b border-[var(--bw-ln)] px-3 py-2 font-semibold">Alerts</div>
            {pending > 0 ? (
              <button type="button" className="it" onClick={() => { setBellOpen(false); navigate('/platform/approval-queue') }}>
                <span className="h-2 w-2 flex-none rounded-full bg-[var(--bw-wa)]" />
                <span className="flex-1">{pending} approval{pending === 1 ? '' : 's'} waiting for you</span>
                <span className="text-[var(--bw-ac)]">Open</span>
              </button>
            ) : (
              <div className="px-5 py-7 text-center">
                <p className="text-[13px] font-medium text-[var(--bw-tx)]">You're all caught up</p>
                <p className="mt-0.5 text-[11px] text-[var(--bw-mu)]">No new platform alerts.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div ref={menuRef} className="relative flex-none">
        <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-haspopup="menu" aria-label="Open account menu" title={name} className="ib">
          <Avatar name={name} />
        </button>
        {open && (
          <div className="pop min-w-[240px]" role="menu">
            <div className="flex items-center gap-2.5 border-b border-[var(--bw-ln)] px-3 py-2.5">
              <Avatar name={name} size={30} />
              <div className="min-w-0">
                <b className="block truncate text-[13px] font-semibold">{name}</b>
                <small className="block truncate text-[11px] text-[var(--bw-mu)]" title={email}>{[me?.role_name, email].filter(Boolean).join(' · ')}</small>
              </div>
            </div>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); navigate('/platform/profile') }} className="it"><Ic n="user" /> My profile</button>
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onToggleTheme?.() }} className="it">
              <Ic n="moon" /> {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            </button>
            <button type="button" role="menuitem" onClick={onLogout} className="it"><Ic n="out" /> Sign out</button>
          </div>
        )}
      </div>
    </header>
  )
}
