import { useCallback, useEffect, useRef, useState } from 'react'
import { platformApi, type ChangeRow, type ChangesOverview } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { BwModal, Btn, C, Empty, Field, Ic, Kv, Note, Panel, Pill, errMsg, fd, fdt, inputCls, inputStyle, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, columns and the Schedule change modal follow the Bidwise prototype Change & maintenance page (P.chg / A.chgNew).
// Changes are approved in the platform approval queue; nothing runs on the servers when a change is scheduled or approved.
const REFRESH_MS = 30_000
const TYPES = ['Release', 'Maintenance', 'Migration', 'Security'] as const
// Prototype pc(): PILLC word lists; change types match none of them and fall back to "inf".
const PILL_TONE: Record<string, Tone> = { Approved: 'ok', Pending: 'wa', Medium: 'wa', Rejected: 'ba', Failed: 'ba', High: 'ba', Low: 'mu', Cancelled: 'mu' }
const pill = (s: string) => <Pill t={PILL_TONE[s] ?? 'inf'}>{s}</Pill>
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => isoDay(new Date())
const daysFromToday = (iso: string) => Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(`${today()}T00:00:00`).getTime()) / 864e5)

// Prototype dueCell(): date, then "in Nd" / "today" / "Nd ago"; overdue in red, within a week in amber.
function WindowCell({ r }: { r: ChangeRow }) {
  const n = daysFromToday(r.window_start)
  const color = r.status === 'approved' || r.status === 'pending' ? (n < 0 ? C.ba : n <= 7 ? C.wa : undefined) : undefined
  return <span style={{ color }} title={r.in_freeze ? 'Inside a change freeze – two approvals needed' : undefined}>
    {fd(r.window_start)}{r.window_end !== r.window_start && ` – ${fd(r.window_end)}`} <small>{n < 0 ? `${-n}d ago` : n === 0 ? 'today' : `in ${n}d`}</small>
  </span>
}

const approvalLabel = (r: ChangeRow) => r.status === 'pending' && r.approvals_required > 1 ? `${r.approval} · ${r.approvals.length} of ${r.approvals_required}` : r.approval

const COLS: GridCol<ChangeRow>[] = [
  { k: 'code', t: 'Change', fn: r => <b>{r.code}</b>, sv: r => r.id },
  { k: 'description', t: 'Description', w: 320 },
  { k: 'type', t: 'Type', fn: r => pill(r.type) },
  { k: 'scope', t: 'Scope' },
  { k: 'window_start', t: 'Window', date: true, fn: r => <WindowCell r={r} />, txt: r => r.window_start, sv: r => r.window_start },
  { k: 'risk', t: 'Risk', fn: r => pill(r.risk) },
  { k: 'owner', t: 'Owner', txt: r => r.owner ?? '' },
  { k: 'approval', t: 'Approval', fn: r => <Pill t={PILL_TONE[r.approval] ?? 'inf'} title={r.in_freeze ? 'Change freeze: two approvals from the change board' : undefined}>{approvalLabel(r)}</Pill>, txt: approvalLabel },
]

function ScheduleModal({ onClose, onDone }: { onClose: () => void; onDone: (r: ChangeRow) => void }) {
  const { error: showError } = useToast()
  const [description, setDescription] = useState('')
  const [type, setType] = useState<string>(TYPES[0])
  const [window_, setWindow] = useState(() => isoDay(new Date(Date.now() + 7 * 864e5)))
  const [busy, setBusy] = useState(false)
  const problem = description.trim().length < 5 ? 'Describe the change (at least 5 characters)' : !window_ ? 'Choose a window' : window_ < today() ? 'The window can’t be in the past' : ''
  const [touched, setTouched] = useState(false)
  const submit = async () => {
    setTouched(true)
    if (problem) return
    setBusy(true)
    try { onDone((await platformApi.scheduleChange({ description: description.trim(), type, window: window_ })).data) }
    catch (err) { showError(errMsg(err, 'The change could not be submitted')) }
    finally { setBusy(false) }
  }
  return <BwModal title="Schedule change" width={500} onClose={() => !busy && onClose()} foot={<>
    <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
    <Btn p disabled={busy} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit for approval'}</Btn>
  </>}>
    <div className="grid gap-2.5 sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Description"><input className={inputCls} style={inputStyle} value={description} maxLength={500} autoFocus onChange={e => setDescription(e.target.value)} /></Field></div>
      <Field label="Type"><select className={inputCls} style={inputStyle} value={type} onChange={e => setType(e.target.value)}>{TYPES.map(t => <option key={t}>{t}</option>)}</select></Field>
      <Field label="Window"><input type="date" className={inputCls} style={inputStyle} value={window_} min={today()} onChange={e => setWindow(e.target.value)} /></Field>
    </div>
    {touched && problem && <small className="mt-1.5 block text-xs" style={{ color: C.ba }}>{problem}</small>}
  </BwModal>
}

function ChangeModal({ r, canManage, onClose, onDone }: { r: ChangeRow; canManage: boolean; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast()
  const [note, setNote] = useState('')
  const [window_, setWindow] = useState(r.window_start)
  const [busy, setBusy] = useState('')
  const act = async (key: string, fn: () => Promise<{ data: unknown }>, done: string) => {
    setBusy(key)
    try { const { data } = await fn(); success((data as { message?: string }).message || done); onDone() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy('') }
  }
  const reschedulable = canManage && r.type !== 'Freeze' && (r.status === 'pending' || r.status === 'approved') && !r.executed_at
  const decide = r.can_decide && r.approval_request_id != null
  return <BwModal title={<>{r.code} {pill(approvalLabel(r))}</>} width={560} onClose={onClose} foot={<>
    <Btn onClick={onClose}>Close</Btn>
    {decide && <>
      <Btn d disabled={!!busy} onClick={() => void act('reject', () => platformApi.rejectRequest(r.approval_request_id!, note.trim() || undefined), `${r.code} rejected`)}>Reject</Btn>
      <Btn p disabled={!!busy} onClick={() => void act('approve', () => platformApi.approveRequest(r.approval_request_id!, note.trim() || undefined), `${r.code} approved`)}>Approve</Btn>
    </>}
  </>}>
    <div className="mb-2">{r.description}</div>
    <Kv rows={[
      ['Type', r.type], ['Scope', r.scope], ['Window', <WindowCell key="w" r={r} />], ['Risk', r.risk],
      ['Owner', r.owner ?? '—'], ['Submitted', fdt(r.created_at)],
      ['Approvals needed', r.type === 'Freeze' ? 'Configured in Control Center' : `${r.approvals_required}${r.in_freeze ? ' (change freeze)' : ''}`],
      ['Approved by', r.approvals.length ? r.approvals.map(a => `${a.name ?? '—'} · ${fdt(a.at)}${a.note ? ` · “${a.note}”` : ''}`).join('; ') : '—'],
      ['Decision', r.decided_at && r.status !== 'pending' ? `${r.approval} by ${r.decided_by ?? '—'} · ${fdt(r.decided_at)}${r.decision_note ? ` · “${r.decision_note}”` : ''}` : '—'],
      ['Executed', r.executed_at ? `${fdt(r.executed_at)} · ${r.execution_ref ?? ''}` : '—'],
    ]} />
    {decide && <div className="mt-2.5"><Field label="Decision note (optional)"><input className={inputCls} style={inputStyle} value={note} maxLength={500} onChange={e => setNote(e.target.value)} /></Field></div>}
    {!decide && r.status === 'pending' && <small className="mt-2 block text-xs" style={{ color: C.mu }}>Waiting in Approval Actions for a change-board member with Change &amp; Maintenance manage access{r.in_freeze ? ' – two different approvers, neither the requester' : ', other than the requester'}.</small>}
    {reschedulable && <div className="mt-2.5 flex items-end gap-2">
      <div className="flex-1"><Field label="Reschedule window"><input type="date" className={inputCls} style={inputStyle} value={window_} min={today()} onChange={e => setWindow(e.target.value)} /></Field></div>
      <Btn disabled={!!busy || !window_ || window_ === r.window_start} title="Moves the window and sends the change for approval again"
        onClick={() => void act('reschedule', () => platformApi.rescheduleChange(r.id, window_), `${r.code} rescheduled – approval requested again`)}>Reschedule</Btn>
    </div>}
  </BwModal>
}

export default function PlatformChangesPage() {
  const { can } = usePlatformAccess()
  const { success } = useToast()
  const [data, setData] = useState<ChangesOverview | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)
  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try { const { data: next } = await platformApi.changesOverview(); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Change & maintenance unavailable')) }
  }, [])
  useEffect(() => {
    void load()
    const t = window.setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
    return () => window.clearInterval(t)
  }, [load])

  const canManage = can('changes', 'manage') && !!data?.all_scope
  const denied = !can('changes', 'manage') ? 'Your platform role can’t schedule changes' : data && !data.all_scope ? 'Scheduling changes needs all-tenant scope' : undefined
  const freeze = data?.freeze
  const inside = freeze?.changes_inside ? ` ${freeze.changes_inside} scheduled change${freeze.changes_inside === 1 ? ' falls' : 's fall'} inside it.` : ''
  const freezeText = !freeze ? '' : !freeze.enabled ? 'Change freeze windows are off in Control Center.'
    : freeze.active ? `Change freeze in effect until ${fd(freeze.end)}.${inside}`
    : freeze.start ? `Change freeze starts ${fd(freeze.start)}.${inside}` : 'No change freeze is scheduled.'
  const open = data?.changes.find(c => c.id === openId) ?? null

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {creating && <ScheduleModal onClose={() => setCreating(false)} onDone={r => { setCreating(false); success(`${r.code} submitted to the change board`); void load() }} />}
    {open && <ChangeModal r={open} canManage={canManage} onClose={() => setOpenId(null)} onDone={() => void load()} />}
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Change &amp; maintenance</h1></div>
      <span className="flex-1" />
      <Btn p disabled={!canManage} title={denied} onClick={() => setCreating(true)}><Ic n="plus" /> Schedule change</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {freeze && <Note info className="mb-2">{freezeText} Changes inside a freeze need four-eyes approval from the change board.</Note>}
    <Panel title="Change calendar" flush>
      {!data ? <Empty>{error || 'Loading…'}</Empty>
        : <BwGrid id="chg" cols={COLS} rows={data.changes} rid={r => String(r.id)} onRow={r => setOpenId(r.id)} empty="No changes scheduled" />}
    </Panel>
  </div>
}
