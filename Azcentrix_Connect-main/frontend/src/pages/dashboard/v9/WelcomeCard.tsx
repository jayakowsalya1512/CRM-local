import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store'
import { usePermissions } from '@/hooks'
import { Ic } from '@/components/crm/kit'
import { useWelcome } from './data'
import { ROUTE } from './records'

// Prototype v9 dashHero(): date, time-of-day greeting with the signed-in user's first name, four summary chips that
// open the matching module, and the "New lead" / "Log activity" actions. Counts come from GET /dashboard/v9/welcome.
export default function WelcomeCard({ nonce = 0 }: { nonce?: number }) {
  const navigate = useNavigate()
  const { can } = usePermissions()
  const user = useAuthStore(s => (s as any).user)
  const w = useWelcome(nonce).data
  const first = String(user?.full_name || user?.username || '').trim().split(/\s+/)[0]
  const h = new Date().getHours()
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const n = (v: number | undefined) => (v == null ? '–' : v)
  const plural = (v: number | undefined, word: string) => `${n(v)} ${word}${v === 1 ? '' : 's'}`

  return <div className="bwd-hero">
    <div className="min-w-0 flex-1">
      <div className="bwd-hero-date">{today}</div>
      <h2>{greeting}{first ? `, ${first}` : ''}</h2>
      <div className="chips">
        <button type="button" className="dchip" onClick={() => navigate(ROUTE.tenders)}><Ic n="file" size={14} />{plural(w?.bids_due, 'bid')} due this week</button>
        <button type="button" className="dchip" onClick={() => navigate(ROUTE.approvals)}><Ic n="check" size={14} />{plural(w?.approvals, 'approval')} waiting</button>
        <button type="button" className="dchip" onClick={() => navigate(ROUTE.kam)}><Ic n="bell" size={14} />{plural(w?.tasks_today, 'task')} due today</button>
        <button type="button" className="dchip" onClick={() => navigate(ROUTE.leads)}><Ic n="funnel" size={14} />{plural(w?.new_leads, 'new lead')}</button>
      </div>
    </div>
    <div className="bwd-hero-acts">
      {can('leads.create') && <button type="button" className="bw-btn hero-ghost" onClick={() => navigate('/leads/new')}><Ic n="plus" size={14} /> New lead</button>}
      {can('kam.create') && <button type="button" className="bw-btn hero-solid" onClick={() => navigate('/kam?new=activity')}><Ic n="pin" size={14} /> Log activity</button>}
    </div>
  </div>
}
