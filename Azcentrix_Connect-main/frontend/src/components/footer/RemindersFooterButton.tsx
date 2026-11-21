// Prototype v17 footer tab('rem','bell','Reminders',remDue()) — reuses the existing
// Notification feed (lead follow-up alerts, tender deadline reminders — see
// backend/app/services/{followup_alert_service,bid_service}.py) plus Team Chat's own due
// message reminders, instead of a separate "reminders" table. Manual "remind me" entries
// (title + custom time, the prototype's REMM array) reuse sticky_notes' existing
// reminder_at/reminder_sent columns via the Notes API instead of a new table — see
// notes_router.py's NoteIn/NotePatch.reminder_at and sticky_note_service.deliver_due_reminders.
// There's no live-computed overdue-task/EMD aggregation here like the prototype's remList().
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, Plus, X } from 'lucide-react'
import api from '@/services/api'
import chatApi from '@/services/chatApi'
import { notesApi } from '@/pages/notes/notesApi'
import { useChatWidgetStore } from '@/store/chatWidgetStore'
import { useFooterPanelStore } from '@/store/footerPanelStore'

type NotificationItem = {
  id: number; title: string; message: string; action: string | null
  module: string | null; record_id: number | null; is_read: boolean; created_at: string
}
type ChatReminder = { id: number; message_id: number; note: string | null; remind_at: string }

// "sticky_note_reminder" is deliberately excluded — manual reminders are sourced directly
// from /notes (below) instead, which also lets upcoming (not-yet-due) ones show here.
const REMINDER_ACTIONS = new Set(['deadline_reminder', 'followup_alert_1day', 'followup_alert_2day'])

type Row =
  | { kind: 'notification'; id: number; title: string; message: string; dueAt: string; module: string | null; recordId: number | null }
  | { kind: 'chat'; id: number; title: string; message: string; dueAt: string }
  | { kind: 'note'; id: number; title: string; message: string; dueAt: string }

const fmt = (iso: string) => new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
function toneFor(dueAt: string): { cls: string; label: string } {
  const d = new Date(dueAt), now = new Date()
  if (d < now && !isSameDay(d, now)) return { cls: 'ba', label: 'Overdue' }
  if (isSameDay(d, now)) return { cls: 'wa', label: 'Today' }
  return { cls: 'inf', label: 'Upcoming' }
}

function openPathFor(module: string | null, recordId: number | null): string | null {
  if (module === 'leads' && recordId) return `/leads?open=${recordId}`
  if (module === 'tenders') return '/tenders'
  return null
}

function toLocalDatetimeInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function RemindersFooterButton() {
  const navigate = useNavigate()
  const openChat = useChatWidgetStore((s) => s.open)
  const open = useFooterPanelStore((s) => s.panel === 'reminders')
  const toggle = useFooterPanelStore((s) => s.toggle)
  const closePanel = useFooterPanelStore((s) => s.close)
  const [rows, setRows] = useState<Row[]>([])
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [when, setWhen] = useState(() => toLocalDatetimeInputValue(new Date(Date.now() + 60 * 60000)))
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = () => {
    Promise.all([
      api.get<{ items: NotificationItem[] }>('/notifications', { params: { limit: 100 } }).catch(() => ({ data: { items: [] } })),
      chatApi.dueReminders().catch(() => ({ data: [] as ChatReminder[] })),
      notesApi.list().catch(() => ({ items: [], context: null, colors: {} as any })),
    ]).then(([notifRes, chatRes, notesRes]) => {
      const notifRows: Row[] = notifRes.data.items
        .filter((n) => n.action && REMINDER_ACTIONS.has(n.action) && !n.is_read)
        .map((n) => ({ kind: 'notification', id: n.id, title: n.title, message: n.message, dueAt: n.created_at, module: n.module, recordId: n.record_id }))
      const chatRows: Row[] = chatRes.data.map((r) => ({ kind: 'chat', id: r.id, title: 'Chat reminder', message: r.note || 'A message you asked to be reminded about', dueAt: r.remind_at }))
      const noteRows: Row[] = notesRes.items
        .filter((n) => n.reminder_at && !n.reminder_sent)
        .map((n) => ({ kind: 'note', id: n.id, title: 'Reminder', message: n.content.length > 140 ? `${n.content.slice(0, 140)}…` : n.content, dueAt: n.reminder_at as string }))
      setRows([...notifRows, ...chatRows, ...noteRows].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()))
    })
  }

  useEffect(() => { refresh(); const t = window.setInterval(refresh, 60_000); return () => window.clearInterval(t) }, [])

  useEffect(() => {
    if (!open) return
    refresh()
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closePanel() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const dismiss = (row: Row) => {
    const req = row.kind === 'chat' ? chatApi.dismissReminder(row.id)
      : row.kind === 'note' ? notesApi.update(row.id, { clear_reminder: true })
      : api.put(`/notifications/${row.id}/read`)
    req.then(() => setRows((rs) => rs.filter((r) => !(r.kind === row.kind && r.id === row.id)))).catch(() => {})
  }

  const openRow = (row: Row) => {
    closePanel()
    if (row.kind === 'chat') { openChat(); return }
    if (row.kind === 'note') { navigate('/notes'); return }
    const path = openPathFor(row.module, row.recordId)
    if (path) navigate(path)
  }

  const addReminder = () => {
    if (!text.trim() || !when || busy) return
    setBusy(true)
    notesApi.create({ content: text.trim(), source: 'quick', reminder_at: new Date(when).toISOString() })
      .then(() => { setText(''); setWhen(toLocalDatetimeInputValue(new Date(Date.now() + 60 * 60000))); setAdding(false); refresh() })
      .finally(() => setBusy(false))
  }

  const dueCount = rows.filter((r) => new Date(r.dueAt) <= new Date()).length

  return <div ref={ref} style={{ display: 'contents' }}>
    <button type="button" className={`tn-ftb ${open ? 'on' : ''}`} onClick={() => toggle('reminders')} aria-expanded={open} aria-haspopup="dialog">
      <Bell size={15} /><span>Reminders</span>{dueCount > 0 && <em className="tn-badge" aria-label={`${dueCount} due`}>{dueCount}</em>}
    </button>
    {open && <div className="tn-ftpn" role="dialog" aria-label="Reminders">
      <div className="tn-fth">
        <Bell size={15} /><b>Reminders</b><span className="flex-1" />
        <button type="button" className="tn-link" onClick={() => setAdding((a) => !a)}><Plus size={13} /> Remind me</button>
        <button type="button" className="tn-x" onClick={closePanel} aria-label="Close"><X size={15} /></button>
      </div>
      {adding && (
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input className="form-control" placeholder="Remind me to…" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addReminder()} autoFocus />
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="form-control" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={{ flex: 1 }} />
            <button type="button" className="btn btn-primary btn-sm" onClick={addReminder} disabled={!text.trim() || busy}>Add</button>
          </div>
        </div>
      )}
      <div className="tn-ftb3">
        {rows.length ? rows.map((row) => {
          const tone = toneFor(row.dueAt)
          return (
            <div key={`${row.kind}-${row.id}`} className="tn-annc un" style={{ cursor: 'default' }}>
              <div className="flex items-center gap-1.5">
                <span className={`tn-pill ${tone.cls}`}>{tone.label}</span>
                <span className="tn-pill inf">{row.kind === 'chat' ? 'Chat' : row.kind === 'note' ? 'Custom' : row.module || 'Reminder'}</span>
                <small>{fmt(row.dueAt)}</small>
              </div>
              <b>{row.title}</b>
              <div className="tn-msg">{row.message}</div>
              <div className="flex items-center gap-2" style={{ marginTop: 6 }}>
                <button type="button" className="tn-link" onClick={() => openRow(row)}>Open</button>
                <button type="button" className="tn-link" onClick={() => dismiss(row)}>Dismiss</button>
              </div>
            </div>
          )
        }) : <div className="tn-empty">Nothing due right now</div>}
      </div>
    </div>}
  </div>
}
