import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import GlobalSearch from '@/components/layout/GlobalSearch'
import { errMsg as noteErr, notesApi } from '@/pages/notes/notesApi'
import HelpSupport from '@/components/layout/HelpSupport'
import QuickTour from '@/components/layout/QuickTour'
import { useAuthStore, useThemeStore } from '@/store'
import { useNotifStore } from '@/store/notifStore'
import { clearPermissionCache } from '@/hooks/Usepermissions'
import { formatRoleDisplayName, usePermissions } from '@/hooks'
import api, { authApi } from '@/services/api'
import { useToast } from '@/components/ui/ToastContext'
import { Avatar, Ic } from './kit'
import { ago } from '@/pages/notifications/inboxApi'
import { useCrmHeaderPopStore } from '@/store/crmHeaderPopStore'


function usePop() {
  const { open, setOpen, toggle } = useCrmHeaderPopStore()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [open, setOpen])
  return { open, setOpen, ref, toggle }
}

// Prototype shows one line per notification: the message, prefixed by the title when the message doesn't already say it.
const notifText = (n: any) => { const t = String(n.title || '').trim(), m = String(n.message || n.text || '').trim(); return !t || m.toLowerCase().includes(t.toLowerCase()) ? (m || t) : m ? `${t}: ${m}` : t }

function Bell({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { setUnread, refresh } = useNotifStore()
  const [items, setItems] = useState<any[] | null>(null)
  useEffect(() => {
    api.get('/notifications?mine_only=true&limit=6').then(r => {
      const list = Array.isArray(r.data) ? r.data : r.data?.items ?? []
      setItems(list)
      if (typeof r.data?.unread_count === 'number') setUnread(r.data.unread_count)
    }).catch(() => setItems([]))
  }, [setUnread])
  const read = async (n: any) => {
    setItems(L => L?.map(x => x.id === n.id ? { ...x, is_read: true } : x) ?? L)
    try { const r = await api.put(`/notifications/${n.id}/read`); if (typeof r.data?.unread_count === 'number') setUnread(r.data.unread_count) } catch { refresh() }
    // Prototype readN(): mark read, close, open Inbox & Notifications.
    onClose(); navigate('/notifications')
  }
  return <div className="pop" style={{ width: 340 }}>
    <div className="flex items-center gap-2 border-b px-3 py-2 font-semibold" style={{ borderColor: 'var(--bw-ln)' }}>Notifications<span className="flex-1" />
      <a className="text-xs font-medium" onClick={() => { navigate('/notifications'); onClose() }}>View all</a></div>
    {items == null ? <div className="px-3 py-4 text-xs" style={{ color: 'var(--bw-mu)' }}>Loading…</div>
      : !items.length ? <div className="px-3 py-4 text-xs" style={{ color: 'var(--bw-mu)' }}>You're all caught up</div>
        : items.map(n => <button key={n.id} type="button" className="it" onClick={() => read(n)} style={n.is_read || n.read ? undefined : { background: 'color-mix(in srgb, var(--bw-ac) 7%, var(--bw-sf))' }}>
          <div className="min-w-0"><div className="line-clamp-2">{notifText(n)}</div><small style={{ color: 'var(--bw-mu)' }}>{ago(n.created_at)}</small></div>
        </button>)}
  </div>
}

export default function CrmHeader({ theme, onToggleTheme, onToggleSidebar, toggleTitle = 'Toggle sidebar' }: {
  theme: 'light' | 'dark'; onToggleTheme: () => void; onToggleSidebar: () => void; toggleTitle?: string
}) {
  const navigate = useNavigate()
  const { user, logout } = useAuthStore() as any
  const tenantSlug = useAuthStore(s => s.tenant_slug)
  const company = useThemeStore(s => s.theme.company_name) || 'Azcentrix'
  const { roleDisplay, can } = usePermissions() as any
  // Prototype quick-create menu; each entry follows the user's create permission.
  const createItems = ([
    ['/leads/new', 'Lead', 'funnel', 'leads.create'], ['/opportunities/new', 'Opportunity', 'target', 'opportunities.create'],
    ['/tenders/new', 'Tender', 'file', 'tenders.create'], ['/quotations/new', 'Quotation', 'doc', 'quotations.create'],
    ['/customers/new', 'Customer', 'building', 'customers.create'], ['/kam/log', 'Log activity', 'clock', 'kam.create'],
    ['/travel/new', 'Travel request', 'plane', 'travel.create'], ['/emdbg', 'EMD / BG entry', 'shield', 'emdbg.create'],
  ] as const).filter(x => can(x[3])).map(x => [x[0], x[1], x[2]] as const)
  const { unread, refresh } = useNotifStore()
  const { success, error: showError } = useToast()
  const pop = usePop()
  const [tour, setTour] = useState(false)

  useEffect(() => { refresh(); const t = window.setInterval(refresh, 30_000); return () => window.clearInterval(t) }, [refresh])

  // The prototype search box opens the existing global search palette (same as Ctrl K).
  const openSearch = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  const go = (to: string) => { pop.setOpen(null); navigate(to) }
  const signOut = async () => { try { await authApi.logout() } catch { /* sign out locally regardless */ } finally { clearPermissionCache(); logout() } }
  const signOutOthers = async () => {
    pop.setOpen(null)
    const { confirmAction } = await import('@/utils/sweetAlert')
    if (!await confirmAction({ title: 'Logout All Devices?', text: 'This will sign out your other active devices. This device will stay signed in.', confirmButtonText: 'Logout All Devices' })) return
    try { const r = await authApi.logoutAllMyDevices(); success(r.data?.message || 'Logged out other active devices') } catch (e: any) { showError(e?.response?.data?.detail || 'Failed to log out all devices') }
  }
  const role = roleDisplay || formatRoleDisplayName(user?.role)
  const Item = ({ icon, children, onClick }: { icon: string; children: ReactNode; onClick: () => void }) => <button type="button" className="it" onClick={onClick}><Ic n={icon} />{children}</button>

  return (
    <header className="crm-top" ref={pop.ref}>
      <button type="button" className="ib" onClick={onToggleSidebar} aria-label={toggleTitle} title={toggleTitle}><Ic n="menu" /></button>
      <div className="sr" role="search">
        <Ic n="search" />
        <input readOnly placeholder="Search customers, tenders, quotations…" onClick={openSearch} onFocus={e => { e.currentTarget.blur(); openSearch() }} aria-label="Search (Ctrl K)" />
        <kbd>Ctrl K</kbd>
      </div>
      <div className="crm-gs"><GlobalSearch /></div>
      <span className="hidden truncate text-[13px] md:inline" style={{ color: 'var(--bw-mu)' }}>{company}</span>
      <span className="flex-1" />

      {createItems.length > 0 && <div className="relative">
        <button type="button" className="crm-create" onClick={() => pop.toggle('create')} aria-expanded={pop.open === 'create'}><Ic n="plus" /> Create</button>
        {pop.open === 'create' && <div className="pop" style={{ width: 200 }}>
          {createItems.map(([to, label, icon]) => <Item key={label} icon={icon} onClick={() => go(to)}>{label}</Item>)}
          {user?.id && <Item icon="note" onClick={() => { pop.setOpen(null); notesApi.create({ source: 'create_menu', color: 'yellow' }).then(() => navigate('/notes')).catch(e => showError(noteErr(e, 'Could not create the note'))) }}>Sticky note</Item>}
        </div>}
      </div>}
      {can('insights.view') && <button type="button" className="ib" title="AI Insights" aria-label="AI Insights" onClick={() => go('/insights')}><Ic n="spark" /></button>}
      {user?.id && <button type="button" className="ib" title="Sticky notes" aria-label="Sticky notes" onClick={() => go('/notes')}><Ic n="note" /></button>}
      <div className="relative">
        <button type="button" className="ib" title="Help & support" aria-label="Help & support" onClick={() => pop.toggle('help')} aria-expanded={pop.open === 'help'}><Ic n="life" /></button>
        <HelpSupport open={pop.open === 'help'} onClose={() => pop.setOpen(null)} onQuickTour={() => { pop.setOpen(null); setTour(true) }}
          onDocumentLibrary={() => go('/document-management')} onVideoTutorials={() => { success('Video tutorials will be available here soon.'); pop.setOpen(null) }}
          onReportIssue={() => { window.location.href = 'mailto:support@azcentrix.com?subject=Azcentrix%20Connect%20Issue%20Report' }}
          onAiAssistant={() => { success('The AI Help Assistant will be available here soon.'); pop.setOpen(null) }}
          onContactSupport={() => { window.location.href = 'mailto:support@azcentrix.com' }}
          onAskAssistant={q => { success(`AI Help Assistant: We received your question: “${q}”`); pop.setOpen(null) }} />
      </div>
      <div className="relative">
        <button type="button" className="ib" title="Notifications" aria-label="Notifications" onClick={() => pop.toggle('bell')} aria-expanded={pop.open === 'bell'}>
          <Ic n="bell" />{unread > 0 && <span className="dot">{unread > 99 ? '99+' : unread}</span>}
        </button>
        {pop.open === 'bell' && <Bell onClose={() => pop.setOpen(null)} />}
      </div>
      <div className="relative">
        <button type="button" className="ib" aria-label="Account" onClick={() => pop.toggle('me')} aria-expanded={pop.open === 'me'}><Avatar name={user?.full_name || user?.email || '?'} size={24} /></button>
        {pop.open === 'me' && <div className="pop" style={{ width: 240 }}>
          <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--bw-ln2)' }}><b>{user?.full_name || user?.email}</b><br /><small style={{ color: 'var(--bw-mu)' }}>{role} · {company}</small></div>
          <Item icon="user" onClick={() => go('/settings/profile')}>My profile</Item>
          <Item icon="gear" onClick={() => go('/settings')}>Settings</Item>
          <Item icon="moon" onClick={() => { onToggleTheme(); pop.setOpen(null) }}>{theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}</Item>
          <Item icon="lock" onClick={signOutOthers}>Log out other devices</Item>
          <Item icon="out" onClick={signOut}>Sign out</Item>
        </div>}
      </div>
      <QuickTour open={tour} userName={user?.full_name} onClose={() => setTour(false)} />
    </header>
  )
}
