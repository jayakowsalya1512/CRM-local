import { useCallback, useEffect, useState } from 'react'
import { platformApi, type AnnouncementType, type AnnouncementsOverview, type FeedAnnouncement } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Bar, Btn, BwModal, C, Empty, Field, Ic, Loading, Note, PageHead, Panel, Pill, Strip, Table, errMsg, fd, inputCls, num, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, labels and modals follow the Bidwise prototype v9 Announcements & maintenance page (P.announce, A.pAnnNew,
// A.pMaint). Every number comes from the platform API: posts, their audience reach, read receipts and the change calendar.
const PAGE = 20
const TYPES: AnnouncementType[] = ['Info', 'Important', 'Maintenance']
export const typeTone = (t: string): Tone => t === 'Maintenance' ? 'wa' : t === 'Important' ? 'ba' : 'inf'
const statusTone = (s: string): Tone => s === 'Completed' ? 'ok' : s === 'Rejected' || s === 'Failed' ? 'ba' : s === 'Awaiting approval' || s === 'In progress' ? 'wa' : 'inf'
const isoDay = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function NewAnnouncement({ tenants, onClose, onDone }: { tenants: AnnouncementsOverview['tenants']; onClose: () => void; onDone: () => void }) {
  const { success, warning, error: showError } = useToast()
  const [f, setF] = useState({ title: '', message: '', type: 'Info' as AnnouncementType, until: isoDay(7), audience: 'all' })
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const invalid = { title: !f.title.trim(), message: !f.message.trim(), until: !f.until || f.until < isoDay(0) }
  const publish = async () => {
    setTried(true)
    if (invalid.title) return showError('Add a title')
    if (invalid.message) return showError('Add a message')
    if (invalid.until) return showError('“Show until” can’t be in the past')
    setBusy(true)
    try {
      const { data } = await platformApi.publishAnnouncement({ ...f, title: f.title.trim(), message: f.message.trim() })
      success(`Published to ${data.audience} – it now shows in their footer`)
      if (data.failed.length) warning(`${data.failed.length} tenant(s) could not be reached and were skipped: ${data.failed.map(x => x.tenant).join(', ')}`)
      onDone(); onClose()
    } catch (err) { showError(errMsg(err, 'The announcement could not be published')) } finally { setBusy(false) }
  }
  const err = (bad: boolean) => tried && bad ? 'err' : ''
  return <BwModal title="New announcement" width={560} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p onClick={() => void publish()} disabled={busy}>{busy ? 'Publishing…' : 'Publish'}</Btn></>}>
    <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="Title" req><input className={`${inputCls} ${err(invalid.title)}`} value={f.title} maxLength={200} autoFocus onChange={e => set('title', e.target.value)} /></Field></div>
      <div className="sm:col-span-2"><Field label="Message" req><textarea className={`${inputCls} ${err(invalid.message)}`} rows={4} maxLength={5000} value={f.message} onChange={e => set('message', e.target.value)} /></Field></div>
      <Field label="Type"><select className={inputCls} value={f.type} onChange={e => set('type', e.target.value as AnnouncementType)}>{TYPES.map(t => <option key={t}>{t}</option>)}</select></Field>
      <Field label="Show until"><input type="date" className={`${inputCls} ${err(invalid.until)}`} min={isoDay(0)} max={isoDay(365)} value={f.until} onChange={e => set('until', e.target.value)} /></Field>
      <div className="sm:col-span-2"><Field label="Audience"><select className={inputCls} value={f.audience} onChange={e => set('audience', e.target.value)}>
        <option value="all">All tenants</option><option value="enterprise">Enterprise plans</option><option value="trial">Trial tenants</option>
        {tenants.length > 0 && <optgroup label="Specific tenant">{tenants.map(t => <option key={t.id} value={`tenant:${t.id}`}>{t.name}</option>)}</optgroup>}
      </select></Field></div>
    </div>
  </BwModal>
}

function ScheduleMaintenance({ scopes, onClose, onDone }: { scopes: AnnouncementsOverview['scopes']; onClose: () => void; onDone: () => void }) {
  const { success, warning, error: showError } = useToast()
  const [f, setF] = useState({ title: '', date: isoDay(7), window: '02:00 – 04:00 IST', scope: scopes[0]?.key ?? 'all', notify: true })
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(x => ({ ...x, [k]: v }))
  const m = /^\s*(\d{1,2}):(\d{2})\s*(?:–|—|-|to)\s*(\d{1,2}):(\d{2})\s*(?:IST)?\s*$/i.exec(f.window)
  const windowOk = !!m && +m[1] < 24 && +m[3] < 24 && +m[2] < 60 && +m[4] < 60 && +m[3] * 60 + +m[4] > +m[1] * 60 + +m[2]
  const invalid = { title: f.title.trim().length < 5, date: !f.date || f.date < isoDay(0), window: !windowOk }
  const schedule = async () => {
    setTried(true)
    if (invalid.title) return showError('Describe the work (at least 5 characters)')
    if (invalid.date) return showError('The date can’t be in the past')
    if (invalid.window) return showError('Enter the window as HH:MM – HH:MM, ending after it starts')
    setBusy(true)
    try {
      const { data } = await platformApi.scheduleMaintenance({ ...f, title: f.title.trim() })
      success(data.approval_required ? `${data.code} scheduled – waiting for approval in the change calendar` : `Maintenance ${data.code} scheduled`)
      if (data.warning) warning(data.warning)
      onDone(); onClose()
    } catch (err) { showError(errMsg(err, 'The window could not be scheduled')) } finally { setBusy(false) }
  }
  const err = (bad: boolean) => tried && bad ? 'err' : ''
  return <BwModal title="Schedule maintenance" width={480} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p onClick={() => void schedule()} disabled={busy}>{busy ? 'Scheduling…' : 'Schedule'}</Btn></>}>
    <div className="grid gap-x-3 gap-y-[9px] sm:grid-cols-2">
      <div className="sm:col-span-2"><Field label="What is being done?" req><input className={`${inputCls} ${err(invalid.title)}`} value={f.title} maxLength={500} autoFocus onChange={e => set('title', e.target.value)} /></Field></div>
      <Field label="Date"><input type="date" className={`${inputCls} ${err(invalid.date)}`} min={isoDay(0)} max={isoDay(365)} value={f.date} onChange={e => set('date', e.target.value)} /></Field>
      <Field label="Window"><input className={`${inputCls} ${err(invalid.window)}`} value={f.window} onChange={e => set('window', e.target.value)} placeholder="02:00 – 04:00 IST" /></Field>
      <div className="sm:col-span-2"><Field label="Scope"><select className={inputCls} value={f.scope} onChange={e => set('scope', e.target.value)}>{scopes.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field></div>
    </div>
    <label className="mt-2 flex items-center gap-2" style={{ color: C.tx }}><input type="checkbox" checked={f.notify} onChange={e => set('notify', e.target.checked)} /> Notify tenants in their announcements</label>
    <Note info className="mt-2.5">The window goes to the change calendar for approval. Nothing is stopped or restarted automatically.</Note>
  </BwModal>
}

export default function PlatformAnnouncementsPage() {
  const { can } = usePlatformAccess()
  const { success, error: showError } = useToast()
  const [data, setData] = useState<AnnouncementsOverview | null>(null)
  const [error, setError] = useState('')
  const [offset, setOffset] = useState(0)
  const [modal, setModal] = useState<'new' | 'maint' | null>(null)
  const [del, setDel] = useState<FeedAnnouncement | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (at = offset) => {
    try { const { data } = await platformApi.announcements(at, PAGE); setData(data); setError('') }
    catch (err) { setError(errMsg(err, 'Unable to load announcements')) }
  }, [offset])
  useEffect(() => { void load() }, [load])

  const remove = async () => {
    if (!del) return
    setBusy(true)
    try {
      await platformApi.deleteAnnouncement(del.id)
      success('Removed')
      setDel(null)
      // Step back a page when the last row of a page was removed.
      const back = data && data.announcements.items.length === 1 && offset > 0 ? offset - PAGE : offset
      if (back !== offset) setOffset(back); else void load(back)
    } catch (err) { showError(errMsg(err, 'The announcement could not be deleted')) } finally { setBusy(false) }
  }

  const k = data?.kpis
  const page = data?.announcements
  const canPost = can('tenants', 'manage'), canSchedule = can('changes', 'manage')
  return <div>
    {modal === 'new' && data && <NewAnnouncement tenants={data.tenants} onClose={() => setModal(null)} onDone={() => { setOffset(0); void load(0) }} />}
    {modal === 'maint' && data && <ScheduleMaintenance scopes={data.scopes} onClose={() => setModal(null)} onDone={() => void load()} />}
    {del && <BwModal title="Delete announcement" width={460} onClose={() => setDel(null)} foot={<><Btn onClick={() => setDel(null)}>Cancel</Btn><Btn d disabled={busy} onClick={() => void remove()}><Ic n="trash" /> {busy ? 'Deleting…' : 'Delete'}</Btn></>}>
      <p>Delete <b>{del.title}</b>? It disappears from the footer and dashboard of {del.audience === 'All tenants' ? 'every tenant' : del.audience} immediately. Its read history is removed too.</p>
    </BwModal>}

    <PageHead crumb="Command" title="Announcements & maintenance">
      <Btn p onClick={() => setModal('new')} disabled={!data || !canPost} title={canPost ? undefined : 'Needs Tenants manage access'}><Ic n="megaphone" /> New announcement</Btn>
    </PageHead>
    {error && <Note className="mb-2">{error}</Note>}

    <Strip items={[
      { l: 'Live announcements', v: k ? num(k.live) : '—', kpi: 'announcements.live' },
      { l: 'Users reached', v: k ? num(k.users_reached) : '—', kpi: 'announcements.users_reached' },
      { l: 'Avg read rate', v: k ? (k.avg_read_rate == null ? '—' : `${Math.round(k.avg_read_rate)}%`) : '—', kpi: 'announcements.read_rate' },
      { l: 'Upcoming maintenance', v: k ? num(k.upcoming_maintenance) : '—', dc: 'twarn', kpi: 'announcements.maintenance' },
    ]} />
    <Note info className="mb-2">Announcements appear in the <b>Announcements</b> panel in the footer of every selected tenant and as a banner on the dashboard.</Note>

    <Panel title="Announcements" flush>
      {!data ? (error ? <Empty>{error}</Empty> : <Loading />) : !page?.items.length ? <Empty>No announcements yet. Use New announcement to post one.</Empty> : <>
        <Table head={['Title', 'Type', 'Posted by', 'Posted', 'Until', 'Read', '']} minWidth={860}>
          {page.items.map(a => <tr key={a.id}>
            <td className="max-w-[420px] whitespace-normal"><b>{a.title}</b><br /><small style={{ color: C.mu }} title={a.message}>{a.message.length > 90 ? `${a.message.slice(0, 90)}…` : a.message}</small>
              <br /><small style={{ color: C.mu }}>{a.audience} · {num(a.recipients)} user{a.recipients === 1 ? '' : 's'}{a.failed.length ? ` · ${a.failed.length} unreachable` : ''}</small></td>
            <td><Pill t={typeTone(a.type)}>{a.type}</Pill></td>
            <td>{a.posted_by || '—'}</td>
            <td className="whitespace-nowrap">{fd(a.posted_at)}</td>
            <td className="whitespace-nowrap">{a.until ? <span style={{ color: a.live ? undefined : C.mu }}>{fd(a.until)}</span> : '—'}{!a.live && <> <Pill t="mu">Expired</Pill></>}</td>
            <td className="w-[130px]" title={`${num(a.reads)} of ${num(a.recipients)} users`}>{a.read_rate == null ? <span style={{ color: C.mu }}>—</span> : <Bar value={a.read_rate} tone={C.ac} />}</td>
            <td className="w-[44px] text-right"><Btn s d onClick={() => setDel(a)} disabled={!canPost} title={canPost ? 'Delete' : 'Needs Tenants manage access'}><Ic n="trash" /></Btn></td>
          </tr>)}
        </Table>
        {page.total > page.limit && <div className="bw-pgn">
          <span className="flex-1">{page.offset + 1}–{Math.min(page.offset + page.limit, page.total)} of {num(page.total)}</span>
          <Btn s disabled={page.offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹ Prev</Btn>
          <Btn s disabled={page.offset + page.limit >= page.total} onClick={() => setOffset(offset + PAGE)}>Next ›</Btn>
        </div>}
      </>}
    </Panel>

    <div className="mt-2">
      <Panel title="Maintenance windows" flush act={<Btn s p onClick={() => setModal('maint')} disabled={!data || !canSchedule} title={canSchedule ? undefined : 'Needs Change & Maintenance manage access'}><Ic n="plus" /> Schedule window</Btn>}>
        {!data ? <Loading /> : !data.maintenance.length ? <Empty>No maintenance windows scheduled.</Empty> :
          <Table head={['Window', 'When', 'Scope', 'Status']} minWidth={640}>
            {data.maintenance.map(m => <tr key={m.id}>
              <td><b>{m.title}</b> <small style={{ color: C.mu }}>{m.code}</small></td>
              <td className="whitespace-nowrap">{m.when}</td>
              <td>{m.scope}</td>
              <td><Pill t={statusTone(m.status)}>{m.status}</Pill></td>
            </tr>)}
          </Table>}
      </Panel>
    </div>
  </div>
}
