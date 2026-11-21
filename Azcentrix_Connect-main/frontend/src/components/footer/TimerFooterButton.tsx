// Prototype v17 footer tab('timer','clock','Timer') — while running, the footer button
// itself turns into the live elapsed-time pill (ftHTML(): `S.timer ? <button class="on">
// clock + ftTm</button> : tb('timer', ...)`), ticking every second (same setInterval as
// the prototype's ftClock loop). The panel (ftPanel() k==='timer') is a big centered
// MM:SS readout with a single Start/Stop button.
//
// "Stop & log activity" deep-links into KAM's real Log Activity form (pages/kam/KAMPage.tsx,
// the one with genuine start_time/end_time fields and an auto-computed duration — not the
// prototype's 15/30/45/60/90/120 chip picker) via /kam?logTimer=1&start=&end=&duration=,
// which KAMPage.tsx reads and pre-fills into its form. Other modules' own "Log Activity"
// modals (Customer360/LeadDrawer/DealDrawer) don't have time fields at all, so there's
// nothing to pre-fill there — KAM is the one place this timer's data is actually useful.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, X } from 'lucide-react'
import { useToast } from '@/components/ui/ToastContext'
import { usePermissions } from '@/hooks'
import { useTimerStore } from '@/store/timerStore'
import { useFooterPanelStore } from '@/store/footerPanelStore'

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function fmt(startedAt: number): string {
  const totalSeconds = Math.floor((Date.now() - startedAt) / 1000)
  const mm = Math.floor(totalSeconds / 60)
  const ss = totalSeconds % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export default function TimerFooterButton() {
  const { startedAt, start, stop } = useTimerStore()
  const open = useFooterPanelStore((s) => s.panel === 'timer')
  const toggle = useFooterPanelStore((s) => s.toggle)
  const closePanel = useFooterPanelStore((s) => s.close)
  const [, forceTick] = useState(0)
  const { success } = useToast()
  const { can } = usePermissions()
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!startedAt) return
    const t = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [startedAt])

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closePanel() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc) }
  }, [open, closePanel])

  const handleStopClick = () => {
    const startedAtBeforeStop = startedAt
    const endedAt = new Date()
    const minutes = stop()
    closePanel()
    if (can('kam.create') && startedAtBeforeStop) {
      const start = hhmm(new Date(startedAtBeforeStop))
      const end = hhmm(endedAt)
      navigate(`/kam?logTimer=1&start=${start}&end=${end}&duration=${minutes}`)
      success(`Timer stopped — ${minutes} min, opening Log Activity`)
    } else {
      success(`Timer stopped — ${minutes} min recorded`)
    }
  }

  return <div ref={ref} style={{ display: 'contents' }}>
    {startedAt ? (
      <button type="button" className="tn-ftb on" onClick={() => toggle('timer')}>
        <Clock size={15} /><span>{fmt(startedAt)}</span>
      </button>
    ) : (
      <button type="button" className={`tn-ftb ${open ? 'on' : ''}`} onClick={() => toggle('timer')} aria-expanded={open} aria-haspopup="dialog">
        <Clock size={15} /><span>Timer</span>
      </button>
    )}
    {open && <div className="tn-ftpn" role="dialog" aria-label="Activity timer">
      <div className="tn-fth">
        <Clock size={15} /><b>Activity timer</b><span className="flex-1" />
        <button type="button" className="tn-x" onClick={closePanel} aria-label="Close"><X size={15} /></button>
      </div>
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '.02em', color: 'var(--text-primary)' }}>
          {startedAt ? fmt(startedAt) : '00:00'}
        </div>
        <div className="tn-mu" style={{ marginBottom: 12 }}>Track a visit or call, then log it with the time filled in.</div>
        {startedAt ? (
          <button type="button" className="btn btn-danger" onClick={handleStopClick}>Stop & log activity</button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={start}>Start timer</button>
        )}
      </div>
    </div>}
  </div>
}
