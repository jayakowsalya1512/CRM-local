import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { platformApi, type CannedResponse, type SupportOverview } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Ic, Note, Panel, Pill, Table, errMsg, fdt, inputCls, inputStyle } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import SupportTicketDrawer, { PRIORITY_TONE } from '@/components/platform/SupportTicketDrawer'

// Layout follows the Bidwise prototype Support & announcements page (P.support / annc): Open tickets and Announcements
// side by side, and the Broadcast announcement modal (Audience · Title · Message). Tickets and announcements are real records.
// A ticket opens in a drawer with its thread, SLA clock and the reply editor (?ticket=<id> opens it directly).

const age = (iso: string, now = Date.now()) => {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))
  return mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.floor(mins / 60)}h` : `${Math.floor(mins / 1440)}d`
}
const SENT_TO: Record<string, string> = { all: 'all tenants', admins: 'all tenant admins', groups: 'parent groups' }
const sentOn = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

function BroadcastModal({ data, onClose, onSent }: { data: SupportOverview; onClose: () => void; onSent: () => void }) {
  const { success, warning, error: showError } = useToast()
  const [audience, setAudience] = useState(data.all_scope ? 'all' : `tenant:${data.tenants[0]?.id ?? ''}`)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    try {
      const { data: a } = await platformApi.broadcastAnnouncement({ audience, title, message })
      const reach = `${a.recipients} recipient${a.recipients === 1 ? '' : 's'} in ${a.tenants} tenant${a.tenants === 1 ? '' : 's'}`
      if (a.failed.length) warning('Announcement sent with gaps', `${reach} · not delivered to ${a.failed.map(f => f.tenant).join(', ')}`)
      else success('Announcement sent', reach)
      onSent()
    } catch (err) { showError(errMsg(err, 'Unable to send the announcement')) } finally { setBusy(false) }
  }
  return <BwModal title="Broadcast announcement" width={520} onClose={onClose} foot={<>
    <Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy || !title.trim() || !message.trim()} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</Btn></>}>
    <div className="grid gap-2">
      <Field label="Audience"><select className={inputCls} style={inputStyle} value={audience} onChange={e => setAudience(e.target.value)}>
        {data.all_scope && <><option value="all">All tenants</option><option value="admins">Tenant admins only</option><option value="groups">Parent groups</option></>}
        {data.tenants.map(t => <option key={t.id} value={`tenant:${t.id}`}>{t.name}</option>)}</select></Field>
      <Field label="Title"><input className={inputCls} style={inputStyle} value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></Field>
      <Field label="Message"><textarea className={`${inputCls} h-auto py-1`} style={inputStyle} rows={4} value={message} maxLength={5000} onChange={e => setMessage(e.target.value)} /></Field>
    </div>
  </BwModal>
}

export default function PlatformSupportPage() {
  const { can } = usePlatformAccess()
  const { error: showError } = useToast()
  const [data, setData] = useState<SupportOverview | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState(false)
  const [params, setParams] = useSearchParams()
  const openId = Number(params.get('ticket')) || null
  const [canned, setCanned] = useState<CannedResponse[]>([])
  useEffect(() => { platformApi.cannedResponses().then(({ data: c }) => setCanned(c)).catch(() => setCanned([])) }, [])
  const openTicket = (id: number | null) => setParams(p => { const n = new URLSearchParams(p); if (id) n.set('ticket', String(id)); else n.delete('ticket'); return n })
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.supportOverview(); setData(next); setError('') }
    catch (err) { setError(errMsg(err, 'Support desk unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const page = async (offset: number) => {
    try { const { data: t } = await platformApi.supportTickets(offset); setData(d => d && { ...d, tickets: t }) } catch (err) { showError(errMsg(err, 'Unable to load tickets')) }
  }
  const t = data?.tickets

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <h1 className="flex-1 text-xl font-semibold">Support &amp; announcements</h1>
      <Btn p disabled={!data || !can('tenants', 'manage') || !data.tenants.length} onClick={() => setModal(true)}><Ic n="megaphone" /> Broadcast announcement</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <div className="grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title="Open tickets" flush>
        <Table head={['Ticket', 'Tenant', 'Subject', 'Priority', 'Age']} minWidth={560}>
          {!t ? <tr><td colSpan={5} className="!p-0"><Empty>{error || 'Loading…'}</Empty></td></tr>
            : !t.items.length ? <tr><td colSpan={5} className="!p-0"><Empty>No open tickets. Tickets raised by tenant users appear here.</Empty></td></tr>
              : t.items.map(x => <tr key={x.id} className="cursor-pointer" onClick={() => openTicket(x.id)}
                title={[x.requester && `Raised by ${x.requester}`, x.sla?.breached ? 'SLA breached' : x.sla?.next_due && `${x.sla.next} due ${fdt(x.sla.next_due)}`].filter(Boolean).join(' · ') || undefined}>
                <td className="font-medium">{x.ref}</td><td>{x.tenant}</td><td>{x.subject}</td>
                <td><Pill t={PRIORITY_TONE[x.priority] ?? 'mu'}>{x.priority}</Pill></td><td className="tabular-nums" style={{ color: x.sla?.breached ? C.ba : undefined }}>{age(x.created_at)}</td>
              </tr>)}
        </Table>
        {t && t.total > t.limit && <div className="flex items-center justify-end gap-2 border-t px-2.5 py-1.5 text-xs" style={{ borderColor: C.ln2, color: C.mu }}>
          <span>{t.offset + 1}–{t.offset + t.items.length} of {t.total}</span>
          <Btn s disabled={!t.offset} onClick={() => void page(Math.max(0, t.offset - t.limit))}>Prev</Btn>
          <Btn s disabled={t.offset + t.limit >= t.total} onClick={() => void page(t.offset + t.limit)}>Next</Btn></div>}
      </Panel>
      <Panel title="Announcements" flush>
        {!data ? <Empty>{error || 'Loading…'}</Empty> : !data.announcements.length ? <Empty>No announcements sent yet.</Empty>
          : <div>{data.announcements.map(a => <div key={a.id} className="border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}
            title={`${a.recipients} recipient(s) in ${a.tenants} tenant(s)${a.failed.length ? ` · not delivered to ${a.failed.map(f => f.tenant).join(', ')}` : ''}${a.sent_by ? ` · by ${a.sent_by}` : ''}`}>
            <b>{a.title}</b><br /><small style={{ color: C.mu }}>Sent to {SENT_TO[a.audience] ?? a.audience_label} · {sentOn(a.sent_at)}</small>
          </div>)}</div>}
      </Panel>
    </div>
    {openId && <SupportTicketDrawer id={openId} canned={canned} canManage={can('tenants', 'manage')} onClose={() => openTicket(null)} onChanged={() => void load()} />}
    {modal && data && <BroadcastModal data={data} onClose={() => setModal(false)} onSent={() => { setModal(false); void load() }} />}
  </div>
}
