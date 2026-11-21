import { useEffect, useRef, useState } from 'react'
import api from '@/services/api'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input, Textarea, Select, Checkbox, FormField } from '@/components/ui/Input'
import { MultiSearchableSelect } from '@/components/ui/SearchableSelect'
import { type NewAnnouncement } from './AnnouncementsContext'
import { mapApiErrors, todayISO, validate, type FieldSpec } from '@/utils/validation'

type RoleOption = { name: string; display_name: string }

const TYPE_OPTIONS = [
  { value: 'Info', label: 'Info' },
  { value: 'Important', label: 'Important' },
  { value: 'Maintenance', label: 'Maintenance' },
]
const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const nowLocal = () => toLocalInput(new Date())

// "+ New" compose form in the Announcements footer panel — only shown to roles holding
// announcements.create. A future "Schedule for" time keeps the post hidden from everyone
// (including the author) until that moment; the server enforces this on every feed read.
export default function NewAnnouncementModal({ onClose, onPosted, post }: { onClose: () => void; onPosted: () => void; post: (body: NewAnnouncement) => Promise<{ id: string; scheduled: boolean }> }) {
  const { success, error: showError } = useToast()
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [type, setType] = useState<NewAnnouncement['type']>('Info')
  const [schedule, setSchedule] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const [until, setUntil] = useState('')
  const [roles, setRoles] = useState<RoleOption[]>([])
  const [selectedRoles, setSelectedRoles] = useState<string[]>([])
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])
  useEffect(() => { api.get<RoleOption[]>('/roles').then(({ data }) => setRoles(data)).catch(() => setRoles([])) }, [])

  // field rules: format errors while typing, "required" once a field was left, everything on Post
  type V = { title: string; message: string; scheduledAt: string; until: string; schedule: boolean }
  const specs = (x: V): Record<string, FieldSpec> => {
    const start = x.schedule && x.scheduledAt ? x.scheduledAt.slice(0, 10) : todayISO()
    return {
      title: { label: 'Title', rule: 'text', required: true, min: 3, max: 200 },
      message: { label: 'Message', rule: 'textarea', required: true, max: 5000 },
      until: { label: 'Show until', rule: 'date', minDate: start, dateLabel: { min: x.schedule && x.scheduledAt ? 'the posting date' : 'today' } },
    }
  }
  const scheduleMsg = (x: V) => (!x.schedule ? '' : !x.scheduledAt ? 'Choose when to post this' : x.scheduledAt < nowLocal() ? "Can't schedule in the past" : '')
  const touched = useRef(new Set<string>())
  const cur = (): V => ({ title, message, scheduledAt, until, schedule })
  const check = (x: V, keys: string[], mode: 'change' | 'blur') => {
    const sp = specs(x)
    setErrs(prev => {
      const next = { ...prev }
      for (const k of keys) {
        if (mode === 'blur') touched.current.add(k)
        let m = k === 'scheduledAt' ? scheduleMsg(x) : sp[k] ? validate((x as Record<string, unknown>)[k] as string, sp[k]) : ''
        if (mode === 'change' && !touched.current.has(k) && !prev[k]) {
          // while typing only format errors appear
          m = k === 'scheduledAt' ? (x.scheduledAt && x.scheduledAt < nowLocal() ? m : '') : sp[k] ? validate((x as Record<string, unknown>)[k] as string, { ...sp[k], required: false }) : ''
        }
        if (m) next[k] = m; else delete next[k]
      }
      return next
    })
  }
  const upd = (k: keyof V, v: string | boolean) => {
    const x = { ...cur(), [k]: v } as V
    if (k === 'title') setTitle(v as string)
    else if (k === 'message') setMessage(v as string)
    else if (k === 'scheduledAt') setScheduledAt(v as string)
    else if (k === 'until') setUntil(v as string)
    else setSchedule(v as boolean)
    // until depends on the posting date, so it is re-checked whenever the schedule changes
    check(x, k === 'schedule' || k === 'scheduledAt' ? [k === 'schedule' ? 'scheduledAt' : k, ...(x.until ? ['until'] : [])] : [k], 'change')
  }
  const focusField = (k?: string) => { const el = k ? document.getElementById(`ann-${k}`) : null; if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus() } }

  const save = async () => {
    const x = cur(), sp = specs(x)
    const e: Record<string, string> = {}
    for (const k of Object.keys(sp)) { touched.current.add(k); const m = validate((x as Record<string, unknown>)[k] as string, sp[k]); if (m) e[k] = m }
    const sm = scheduleMsg(x)
    if (sm) e.scheduledAt = sm
    setErrs(e)
    if (Object.keys(e).length) { focusField(['title', 'message', 'until', 'scheduledAt'].find(k => e[k])); return }
    setBusy(true)
    try {
      const data = await post({
        title: title.trim(),
        message: message.trim(),
        type,
        scheduled_at: schedule && scheduledAt ? new Date(scheduledAt).toISOString() : null,
        until: until || null,
        roles: selectedRoles.length ? selectedRoles : null,
      })
      success(data.scheduled ? `Scheduled for ${new Date(scheduledAt).toLocaleString()}` : 'Announcement posted')
      onPosted(); onClose()
    } catch (err: any) {
      const fe = mapApiErrors(err, { scheduled_at: 'scheduledAt' })
      const known = Object.fromEntries(Object.entries(fe).filter(([k]) => ['title', 'message', 'until', 'scheduledAt'].includes(k)))
      if (Object.keys(known).length) { setErrs(prev => ({ ...prev, ...known })); focusField(['title', 'message', 'until', 'scheduledAt'].find(k => known[k])) }
      else showError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'The announcement could not be posted')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Post announcement"
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void save()} loading={busy}>Post</Button>
      </>}
    >
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save() }}>
        <Input
          ref={titleRef}
          id="ann-title"
          label="Title"
          required
          maxLength={200}
          value={title}
          onChange={e => upd('title', e.target.value)}
          onBlur={() => check(cur(), ['title'], 'blur')}
          error={errs.title}
          placeholder="e.g. Office closed on Friday"
        />
        <Textarea
          label="Message"
          required
          rows={4}
          id="ann-message"
          maxLength={5000}
          value={message}
          onChange={e => upd('message', e.target.value)}
          onBlur={() => check(cur(), ['message'], 'blur')}
          error={errs.message}
        />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Select
            label="Type"
            options={TYPE_OPTIONS}
            value={type}
            onChange={e => setType(e.target.value as NewAnnouncement['type'])}
          />
          <Input
            id="ann-until"
            label="Show until (optional)"
            type="date"
            value={until}
            onChange={e => upd('until', e.target.value)}
            onBlur={() => check(cur(), ['until'], 'blur')}
            error={errs.until}
          />
        </div>
        <FormField>
          <Checkbox label="Schedule for later" checked={schedule} onChange={e => upd('schedule', e.target.checked)} />
        </FormField>
        {schedule && (
          <Input
            id="ann-scheduledAt"
            label="Post on"
            required
            type="datetime-local"
            min={nowLocal()}
            value={scheduledAt}
            onChange={e => upd('scheduledAt', e.target.value)}
            onBlur={() => check(cur(), ['scheduledAt'], 'blur')}
            error={errs.scheduledAt}
          />
        )}
        {roles.length > 0 && (
          <MultiSearchableSelect
            label="Audience"
            placeholder="Everyone"
            options={roles.map(r => ({ value: r.name, label: r.display_name }))}
            value={selectedRoles}
            onChange={v => setSelectedRoles(v as string[])}
            placement="bottom"
          />
        )}
      </form>
    </Modal>
  )
}
