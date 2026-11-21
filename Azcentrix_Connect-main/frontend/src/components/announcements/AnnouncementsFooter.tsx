import { useEffect, useRef, useState } from 'react'
import { Megaphone, Plus, X } from 'lucide-react'
import { useAnnouncements, type TenantAnnouncement } from './AnnouncementsContext'
import NewAnnouncementModal from './NewAnnouncementModal'
import QuickNote from '@/components/notes/QuickNote'
import TeamChatFooterButton from '@/components/chat/TeamChatFooterButton'
import RemindersFooterButton from '@/components/footer/RemindersFooterButton'
import RecentFooterButton from '@/components/footer/RecentFooterButton'
import CalculatorFooterButton from '@/components/footer/CalculatorFooterButton'
import TimerFooterButton from '@/components/footer/TimerFooterButton'
import FooterStatus from '@/components/footer/FooterStatus'
import { usePermissions } from '@/hooks'
import { useFooterPanelStore } from '@/store/footerPanelStore'

// Prototype v9 tenant footer (.ft) with its Announcements button and panel (.ftpn / .annc).
const fd = (v: string) => new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
export const annTone = (t: TenantAnnouncement['type']) => t === 'Maintenance' ? 'wa' : t === 'Important' ? 'ba' : 'inf'

export default function AnnouncementsFooter() {
  const { items, unread, markRead, markAllRead, post } = useAnnouncements()
  const { can } = usePermissions()
  const canPost = can('announcements.create')
  const open = useFooterPanelStore((s) => s.panel === 'announcements')
  const toggle = useFooterPanelStore((s) => s.toggle)
  const closePanel = useFooterPanelStore((s) => s.close)
  const [compose, setCompose] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closePanel() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc) }
  }, [open, closePanel])

  return <footer className="tn-ft" ref={ref}>
    {compose && <NewAnnouncementModal post={post} onClose={() => setCompose(false)} onPosted={() => {}} />}
    <button type="button" className={`tn-ftb ${open ? 'on' : ''}`} onClick={() => toggle('announcements')} aria-expanded={open} aria-haspopup="dialog">
      <Megaphone size={15} /><span>Announcements</span>{unread > 0 && <em className="tn-badge" aria-label={`${unread} unread`}>{unread}</em>}
    </button>
    <RemindersFooterButton />
    <RecentFooterButton />
    <TeamChatFooterButton />
    <QuickNote />
    <CalculatorFooterButton />
    <TimerFooterButton />
    <FooterStatus />
    {open && <div className="tn-ftpn" role="dialog" aria-label="Announcements">
      <div className="tn-fth">
        <Megaphone size={15} /><b>Announcements</b><span className="flex-1" />
        {canPost && <button type="button" className="tn-link" onClick={() => setCompose(true)}><Plus size={13} /> New</button>}
        {unread > 0 && <button type="button" className="tn-link" onClick={markAllRead}>Mark all read</button>}
        <button type="button" className="tn-x" onClick={closePanel} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="tn-ftb3">
        {items.length ? items.map(a => <button type="button" key={a.id} className={`tn-annc ${a.read ? '' : 'un'}`} onClick={() => { if (!a.read) markRead(a.id) }}>
          <div className="flex items-center gap-1.5">
            <span className={`tn-pill ${annTone(a.type)}`}>{a.type}</span>
            <small>{fd(a.posted_at)} · {a.posted_by}</small>
            {!a.read && <i className="tn-udot" aria-label="Unread" />}
          </div>
          <b>{a.title}</b>
          <div className="tn-msg">{a.message}</div>
        </button>) : <div className="tn-empty">No announcements</div>}
      </div>
    </div>}
  </footer>
}

// Prototype dashHero() banner (.annb): the newest unread Important / Maintenance announcement, dismissible.
export function AnnouncementBanner() {
  const { items, markRead } = useAnnouncements()
  const a = items.find(x => !x.read && x.type !== 'Info')
  if (!a) return null
  return <div className={`tn-annb ${a.type}`} role="status">
    <Megaphone size={16} className="flex-none" />
    <div className="min-w-0 flex-1"><b>{a.title}</b> <span className="tn-mu">{a.message.length > 220 ? `${a.message.slice(0, 220)}…` : a.message}</span></div>
    <button type="button" className="tn-link" onClick={() => markRead(a.id)}>Dismiss</button>
  </div>
}
