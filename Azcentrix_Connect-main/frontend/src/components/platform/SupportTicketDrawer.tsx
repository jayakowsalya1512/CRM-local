import { useEffect, useRef, useState } from 'react'
import { platformApi, type CannedResponse, type SlaTarget, type TicketDetail } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, C, Drawer, Empty, Kv, Note, Panel, Pill, errMsg, fdt, inputCls, inputStyle, type Tone } from './bw'
import { clearDraft, getDraft, setCurrentTicket, setDraft } from './supportDraft'

// Support Desk ticket: thread, SLA clock (platform_sla), customer rating and the reply editor. The draft is kept per ticket
// in this tab, so canned responses picked here or on the SLA & CSAT page are inserted, never sent, until "Send reply".
export const PRIORITY_TONE: Record<string, Tone> = { Critical: 'ba', High: 'ba', Medium: 'wa', Low: 'mu' }

const left = (secs: number) => {
  const m = Math.abs(Math.round(secs / 60))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h`
}
const targetText = (t: SlaTarget) => t.state === 'met' ? <span style={{ color: C.ok }}>Met · {fdt(t.at)}</span>
  : t.state === 'breached' ? <span style={{ color: C.ba }}>{t.at ? `Breached · answered ${fdt(t.at)}, due ${fdt(t.due)}` : `Breached · due ${fdt(t.due)}`}</span>
    : <span>Due {fdt(t.due)} <small style={{ color: C.mu }}>({left(t.left_secs ?? 0)} left)</small></span>
const mailNote = (e: string | null | undefined) => e === 'sent' ? 'e-mailed to the requester' : e === 'no e-mail' ? 'the requester has no e-mail address' : e ? `e-mail not sent: ${e}` : ''

export default function SupportTicketDrawer({ id, canned, canManage, onClose, onChanged }: {
  id: number; canned: CannedResponse[]; canManage: boolean; onClose: () => void; onChanged: () => void
}) {
  const { success, warning, error: showError } = useToast()
  const [t, setT] = useState<TicketDetail | null>(null)
  const [error, setError] = useState('')
  const [draft, setDraftState] = useState(() => getDraft(id))
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    setT(null); setError(''); setDraftState(getDraft(id))
    platformApi.supportTicket(id)
      .then(({ data }) => { setT(data); setCurrentTicket(data.status === 'closed' ? null : { id: data.id, ref: data.ref }) })
      .catch(err => setError(errMsg(err, 'Unable to load the ticket')))
  }, [id])

  const edit = (v: string) => { setDraftState(v); setDraft(id, v) }
  const insertCanned = (key: string) => {
    const c = canned.find(x => x.key === key)
    if (!c) return
    const el = box.current
    const at = el ? el.selectionStart : draft.length, end = el ? el.selectionEnd : draft.length
    const before = draft.slice(0, at), after = draft.slice(end)
    const sep = before && !before.endsWith('\n') ? '\n\n' : ''
    edit(`${before}${sep}${c.body}${after}`)
    requestAnimationFrame(() => { const pos = (before + sep + c.body).length; el?.focus(); el?.setSelectionRange(pos, pos) })
  }
  const done = (title: string, mail: string | null | undefined, extra = '') => {
    const note = [mailNote(mail), extra].filter(Boolean).join(' · ')
    if (mail && mail !== 'sent' && mail !== 'no e-mail') warning(title, note); else success(title, note)
  }
  const send = async (resolve: boolean) => {
    setBusy(true)
    try {
      const { data: r } = await platformApi.supportReply(id, draft, resolve)
      clearDraft(id); setDraftState(''); setT(r.ticket)
      if (resolve) setCurrentTicket(null)
      done(resolve ? 'Reply sent and ticket resolved' : 'Reply sent', r.email, r.resolved?.rating_link ? 'rating link sent' : '')
      onChanged()
    } catch (err) { showError(errMsg(err, 'Unable to send the reply')) } finally { setBusy(false) }
  }
  const resolve = async () => {
    setBusy(true)
    try {
      const { data: r } = await platformApi.supportResolve(id)
      setT(r.ticket); setCurrentTicket(null)
      done('Ticket resolved', r.email, r.rating_link ? 'rating link included' : '')
      onChanged()
    } catch (err) { showError(errMsg(err, 'Unable to resolve the ticket')) } finally { setBusy(false) }
  }
  const reopen = async () => {
    setBusy(true)
    try {
      const { data: r } = await platformApi.supportReopen(id)
      setT(r.ticket); setCurrentTicket({ id: r.ticket.id, ref: r.ticket.ref })
      success('Ticket reopened', 'The original resolution deadline still applies')
      onChanged()
    } catch (err) { showError(errMsg(err, 'Unable to reopen the ticket')) } finally { setBusy(false) }
  }

  const closed = t?.status === 'closed'
  return <Drawer title={t ? `${t.ref} · ${t.subject}` : 'Ticket'} onClose={onClose}
    sub={t ? `${t.tenant ?? ''} · raised ${fdt(t.created_at)}${t.requester ? ` by ${t.requester}` : ''}` : undefined}
    act={t && <span className="flex gap-1.5"><Pill t={PRIORITY_TONE[t.priority] ?? 'mu'}>{t.priority}</Pill><Pill t={closed ? 'ok' : 'wa'}>{closed ? 'Resolved' : 'Open'}</Pill></span>}>
    {!t ? <Empty>{error || 'Loading…'}</Empty> : <div className="grid gap-3">
      <Panel title="SLA">{t.sla
        ? <Kv rows={[['Priority', t.sla.priority], ['Coverage', t.sla.coverage], ['First response', targetText(t.sla.first_response)], ['Resolution', targetText(t.sla.resolution)],
          ['Policy', t.sla.policy ? `v${t.sla.policy.version} · ${t.sla.policy.first_response_h} h / ${t.sla.policy.resolution_h} h` : '—']]} />
        : <span style={{ color: C.mu }}>No SLA clock – the ticket was raised before SLA tracking, or its tenant has no plan.</span>}</Panel>
      {t.csat && <Note info>Customer rating <b>{t.csat.rating} / 5</b>{t.csat.feedback ? ` – “${t.csat.feedback}”` : ''} · {fdt(t.csat.at)}</Note>}
      <div className="grid gap-2">
        {t.description && <div className="rounded-lg border p-2.5" style={{ borderColor: C.ln2 }}>
          <small style={{ color: C.mu }}>{t.requester ?? 'Requester'} · {fdt(t.created_at)}</small><div className="mt-1 whitespace-pre-wrap">{t.description}</div></div>}
        {t.replies.map(r => <div key={r.id} className="rounded-lg border p-2.5"
          style={{ borderColor: C.ln2, background: r.kind === 'staff' ? 'color-mix(in srgb, var(--bw-ac) 5%, var(--bw-sf))' : undefined }}>
          <small style={{ color: C.mu }}>{r.author ?? (r.kind === 'staff' ? 'Platform support' : 'Tenant')} · {r.kind === 'staff' ? 'support team' : 'tenant'} · {fdt(r.at)}</small>
          <div className="mt-1 whitespace-pre-wrap">{r.body}</div></div>)}
      </div>
      {canManage && <div className="grid gap-1.5">
        <div className="flex items-center gap-2"><b className="flex-1">Reply</b>
          <select className={`${inputCls} sm`} style={{ ...inputStyle, width: 'auto' }} value="" aria-label="Insert canned response" onChange={e => insertCanned(e.target.value)}>
            <option value="">Canned responses…</option>{canned.map(c => <option key={c.key} value={c.key}>{c.title}</option>)}</select></div>
        <textarea ref={box} className={`${inputCls} h-auto py-1`} style={inputStyle} rows={5} maxLength={10000} value={draft}
          placeholder="Write a reply – the draft is kept until you send it" onChange={e => edit(e.target.value)} />
        <div className="flex flex-wrap justify-end gap-1.5">
          {closed ? <Btn disabled={busy} onClick={() => void reopen()}>Reopen</Btn> : <Btn disabled={busy} onClick={() => void resolve()}>Resolve</Btn>}
          {!closed && <Btn disabled={busy || !draft.trim()} onClick={() => void send(true)}>Send &amp; resolve</Btn>}
          <Btn p disabled={busy || !draft.trim()} onClick={() => void send(false)}>{busy ? 'Sending…' : 'Send reply'}</Btn>
        </div>
      </div>}
    </div>}
  </Drawer>
}
