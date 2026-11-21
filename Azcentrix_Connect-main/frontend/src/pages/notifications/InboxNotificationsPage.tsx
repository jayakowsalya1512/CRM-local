// Inbox & Notifications – Bidwise prototype v17 → Application → Inbox & Notifications.
// /notifications        → Notifications (prototype R.notifications: tabs All | Unread | Mentions + Delivery preferences)
// /notifications/inbox  → Inbox (prototype mailTab(): toolbar, 168px folders · 330px list · reading pane)
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { Avatar } from '@/components/platform/bw'
import { useToast } from '@/components/ui/ToastContext'
import { useNotifStore } from '@/store/notifStore'
import ComposeModal, { type ComposeInit } from './ComposeModal'
import { Modal } from './Modal'
import { useAuthStore } from '@/store'
import {
  FOLDERS, ago, errMsg, fmtSize, inboxApi, mailTime, notifApi,
  type CrmRecord, type DeliveryPref, type Folder, type FolderCount, type MailDetail, type MailItem, type MailLabel, type Mailbox, type NotifItem, type People,
} from './inboxApi'
import './inbox.css'

// ─── shared bits ──────────────────────────────────────────────────────────────

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <label className="sw" title={label}><input type="checkbox" checked={on} disabled={disabled} aria-label={label} onChange={e => onChange(e.target.checked)} /><i /></label>
}

const first = (s: string) => (s || '').split(',')[0].trim()
const stripPrefix = (s: string, p: RegExp) => s.replace(p, '')

// ─── page ─────────────────────────────────────────────────────────────────────

// The mail inbox section is removed from the application: this page shows Notifications only, and the old
// /notifications/inbox address redirects here. (InboxView below is kept but no longer rendered.)
export default function InboxNotificationsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const { unread, refresh, setUnread } = useNotifStore()
  const [markAllBusy, setMarkAllBusy] = useState(false)
  const [notifVersion, setNotifVersion] = useState(0)
  const { success, error } = useToast()

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { if (location.pathname.startsWith('/notifications/inbox')) navigate('/notifications', { replace: true }) }, [location.pathname, navigate])

  const readAll = async () => {
    setMarkAllBusy(true)
    try { await notifApi.readAll(); setUnread(0); setNotifVersion(v => v + 1); success('All notifications marked as read') }
    catch (e) { error(errMsg(e, 'Could not mark notifications as read')) }
    finally { setMarkAllBusy(false) }
  }

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">Workspace</div><h1>Notifications</h1></div>
        <span className="fl" />
        <button type="button" className="btn" onClick={readAll} disabled={markAllBusy || unread === 0}><Ic n="check" /> Mark all read</button>
      </div>
      <NotificationsView version={notifVersion} />
    </div>
  )
}

// ─── Notifications (prototype R.notifications) ────────────────────────────────

function NotificationsView({ version }: { version: number }) {
  const navigate = useNavigate()
  const { setUnread } = useNotifStore()
  const { success, error } = useToast()
  const [tab, setTab] = useState<'All' | 'Unread' | 'Mentions'>('All')
  const [items, setItems] = useState<NotifItem[] | null>(null)
  const [prefs, setPrefs] = useState<DeliveryPref[] | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(() => {
    notifApi.feed(tab).then(d => { setItems(d.items); setUnread(d.unread_count) }).catch(e => { setItems([]); error(errMsg(e, 'Could not load notifications')) })
  }, [tab, setUnread, error])
  useEffect(() => { load() }, [load, version])
  useEffect(() => { notifApi.prefs().then(setPrefs).catch(() => setPrefs([])) }, [])

  const readOne = async (n: NotifItem) => {
    try { const r = await notifApi.read(n.id); setUnread(r.unread_count); load() }
    catch (e) { error(errMsg(e, 'Could not mark as read')) }
  }
  const open = async (n: NotifItem) => {
    if (!n.record) return
    if (!n.is_read) { try { const r = await notifApi.read(n.id); setUnread(r.unread_count); if (n.module === 'inbox') load() } catch { /* navigation still works */ } }
    // The mail inbox is not shown in the application, so mail notifications are only marked read.
    if (n.module !== 'inbox') navigate(n.record.route)
  }
  const toggle = async (p: DeliveryPref, on: boolean) => {
    setSaving(p.key)
    setPrefs(L => L?.map(x => x.key === p.key ? { ...x, enabled: on } : x) ?? L)
    try { setPrefs(await notifApi.setPref(p.key, on)); success(`${p.label}: ${on ? 'on' : 'off'}`, 'Saved') }
    catch (e) { setPrefs(L => L?.map(x => x.key === p.key ? { ...x, enabled: !on } : x) ?? L); error(errMsg(e, 'Could not save the preference')) }
    finally { setSaving(null) }
  }

  return (
    <div className="g g21">
      <div className="panel">
        <div className="tabs" role="tablist">
          {(['All', 'Unread', 'Mentions'] as const).map(t => <button key={t} type="button" role="tab" aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        <div className="list">
          {items == null ? <div className="empty">Loading…</div>
            : items.length ? items.map(n => (
              <div key={n.id} className={n.is_read ? '' : 'un'}>
                <span className="fl">{n.text}<br />
                  <small>{ago(n.created_at)}{n.record && <> · <a onClick={() => open(n)}>{n.record.type}{n.record.ref ? ` · ${n.record.ref}` : ''}</a></>}</small>
                </span>
                {!n.is_read && <button type="button" className="btn s g" onClick={() => readOne(n)}>Mark read</button>}
              </div>))
              : <div className="empty">You’re all caught up</div>}
        </div>
      </div>
      <div className="panel">
        <div className="ph">Delivery preferences</div>
        <div className="pb z">
          <div className="list">
            {prefs == null ? <div className="empty">Loading…</div> : prefs.map(p => (
              <div key={p.key}><span className="fl"><b>{p.label}</b><br /><small>{p.summary}</small></span>
                <Switch on={p.enabled} disabled={saving === p.key} label={`${p.label} notifications`} onChange={v => toggle(p, v)} /></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Inbox (prototype mailTab / mailRead) ─────────────────────────────────────

function InboxView({ onUnread }: { onUnread: (n: number) => void }) {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { success, error } = useToast()
  const [folder, setFolder] = useState<Folder>('Inbox')
  const [label, setLabel] = useState<MailLabel>('')
  const [q, setQ] = useState('')
  const [qDeb, setQDeb] = useState('')
  const [items, setItems] = useState<MailItem[] | null>(null)
  const [counts, setCounts] = useState<FolderCount[]>([])
  const [selId, setSelId] = useState<number | null>(null)
  const [sel, setSel] = useState<MailDetail | null>(null)
  const [mailbox, setMailbox] = useState<Mailbox | null>(null)
  const [compose, setCompose] = useState<ComposeInit | null>(null)
  const [linkFor, setLinkFor] = useState<MailDetail | null>(null)
  const [assignFor, setAssignFor] = useState<MailDetail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const reqRef = useRef(0)

  useEffect(() => { inboxApi.mailbox().then(setMailbox).catch(() => setMailbox(null)) }, [])
  useEffect(() => { const t = window.setTimeout(() => setQDeb(q.trim()), 250); return () => window.clearTimeout(t) }, [q])

  const applyCounts = useCallback((f: FolderCount[]) => {
    setCounts(f)
    onUnread(f.find(x => x.name === 'Inbox')?.unread ?? 0)
  }, [onUnread])

  const load = useCallback(async (keepSel = true) => {
    const id = ++reqRef.current
    try {
      const d = await inboxApi.list(folder, label, qDeb)
      if (id !== reqRef.current) return
      setItems(d.items); applyCounts(d.folders)
      if (!keepSel) setSelId(null)
    } catch (e) { if (id === reqRef.current) { setItems([]); error(errMsg(e, 'Could not load mail')) } }
  }, [folder, label, qDeb, applyCounts, error])
  useEffect(() => { load(false) }, [load])

  // Deep link from a notification: /notifications/inbox?m=<id>
  useEffect(() => {
    const m = Number(params.get('m'))
    if (!m) return
    inboxApi.get(m).then(d => { setFolder(d.folder); setSelId(d.id); setSel(d) }).catch(() => error('That message is no longer available'))
    params.delete('m'); setParams(params, { replace: true })
  }, [params, setParams, error])

  // Prototype: the first message of the list is shown when nothing is selected.
  const shownId = selId ?? items?.[0]?.id ?? null
  useEffect(() => {
    if (!shownId) { setSel(null); return }
    if (sel?.id === shownId) return
    let live = true
    inboxApi.get(shownId).then(d => {
      if (!live) return
      setSel(d)
      if (!items?.find(x => x.id === d.id)?.is_read) { setItems(L => L?.map(x => x.id === d.id ? { ...x, is_read: true } : x) ?? L); inboxApi.list(folder, label, qDeb).then(r => applyCounts(r.folders)).catch(() => {}) }
    }).catch(() => { if (live) setSel(null) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId])

  const refreshAll = async (nextSel: number | null = null) => { setSel(null); setSelId(nextSel); await load() }
  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key)
    try { await fn(); if (ok) success(ok) } catch (e) { error(errMsg(e)) } finally { setBusy(null) }
  }

  const star = (e: MailItem) => run(`star${e.id}`, async () => {
    setItems(L => L?.map(x => x.id === e.id ? { ...x, is_starred: !e.is_starred } : x) ?? L)
    await inboxApi.patch(e.id, { is_starred: !e.is_starred })
    if (folder === 'Starred') await load(); else inboxApi.list(folder, label, qDeb).then(r => applyCounts(r.folders)).catch(() => {})
  })
  const move = (m: MailDetail, to: 'Archive' | 'Inbox') => run('move', async () => { await inboxApi.patch(m.id, { folder: to }); await refreshAll() }, `Moved to ${to}`)
  const trash = (m: MailDetail) => run('trash', async () => {
    if (m.folder === 'Trash') {
      const { confirmAction } = await import('@/utils/sweetAlert')
      if (!await confirmAction({ title: 'Delete forever?', text: 'This message will be permanently deleted.', confirmButtonText: 'Delete forever' })) return
      await inboxApi.remove(m.id); await refreshAll(); success('Message deleted')
    } else { await inboxApi.remove(m.id); await refreshAll(); success('Moved to Trash') }
  })
  const restore = (m: MailDetail) => run('restore', async () => { const r = await inboxApi.restore(m.id); await refreshAll(); success(`Restored to ${r.folder}`) })
  const unreadOne = (m: MailDetail) => run('unread', async () => { await inboxApi.patch(m.id, { is_read: false }); setSel(null); setSelId(null); await load(false) })
  const task = (m: MailDetail) => run('task', async () => {
    const r = await inboxApi.task(m.id)
    success(r.kind === 'activity' ? 'Task created from email' : 'Task created from email', r.kind === 'activity' ? `Follow-up activity planned for ${r.due} – see Field Sales calendar` : `Reminder note set for ${r.due}`)
  })
  const lead = (m: MailDetail) => run('lead', async () => {
    const r = await inboxApi.lead(m.id)
    success('Lead created from email – find it in Leads', r.ref)
    setSel(await inboxApi.get(m.id, false))
  })
  const cancelSchedule = (m: MailDetail) => run('unsched', async () => { await inboxApi.cancelSchedule(m.id); await refreshAll() }, 'Schedule cancelled – moved to Drafts')

  const replyInit = (m: MailDetail, all: boolean): ComposeInit => {
    const me = (mailbox?.address || '').toLowerCase()
    const mine = m.is_mine || m.folder === 'Sent'
    const to = mine ? m.to : m.from_email
    const others = all ? [...m.to.split(','), ...m.cc.split(',')].map(s => s.trim()).filter(a => a && a.toLowerCase() !== me && a.toLowerCase() !== to.toLowerCase()) : []
    return {
      to, cc: others.join(', '), subject: 'Re: ' + stripPrefix(m.subject, /^Re: /i), link: m.link ? { module: m.link.module, id: m.link.id } : null,
      body: `\n\n— On ${mailTime(m.time)}, ${m.from_name} wrote:\n${m.body.slice(0, 240)}`, reply_to_id: m.id,
    }
  }
  const forwardInit = (m: MailDetail): ComposeInit => ({
    to: '', subject: 'Fwd: ' + stripPrefix(m.subject, /^Fwd: /i), link: m.link ? { module: m.link.module, id: m.link.id } : null,
    body: `\n\n— On ${mailTime(m.time)}, ${m.from_name} wrote:\n${m.body.slice(0, 240)}`, reply_to_id: m.id,
    attachments: m.attachment_list.map(a => ({ key: `att:${a.id}`, name: a.name })),
  })
  const editInit = (m: MailDetail): ComposeInit => ({
    draft_id: m.id, to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject === '(no subject)' ? '' : m.subject, body: m.body,
    link: m.link ? { module: m.link.module, id: m.link.id } : null, from_mailbox: m.from_mailbox || undefined,
    attachments: m.attachment_list.map(a => ({ key: a.document_key ? `doc:${a.document_key}` : `att:${a.id}`, name: a.name })),
    track: m.track_opens, reply_to_id: m.in_reply_to_id,
  })

  const afterCompose = (r: { status: string; folder: Folder }) => { setCompose(null); setSel(null); setSelId(null); setFolder(r.folder); if (r.folder === folder) load(false) }

  const cnt = (f: Folder) => counts.find(c => c.name === f) ?? { total: 0, unread: 0 }
  const isOut = (e: MailItem) => e.folder === 'Sent' || e.folder === 'Drafts' || e.folder === 'Scheduled'

  return (
    <div className="panel">
      <div className="tbr">
        <button type="button" className="btn p s" onClick={() => setCompose({})}><Ic n="plus" /> Compose</button>
        <input className="in sm" style={{ width: 240 }} placeholder="Search mail…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search mail" />
        {([['', 'All'], ['Internal', 'Internal'], ['External', 'External'], ['Linked', 'Linked to records']] as [MailLabel, string][]).map(([v, t]) =>
          <button key={t} type="button" className={`chip ${label === v ? 'on' : ''}`} onClick={() => { setLabel(v); setSelId(null) }}>{t}</button>)}
        <span className="fl" />
        <small className="mu">{mailbox ? <>{mailbox.address} · {mailbox.smtp_configured ? 'connected mailbox' : 'built-in mail'} <Ic n="check" size={13} /></> : ''}</small>
      </div>
      <div className="mail3">
        <div className="mfol" role="tablist" aria-label="Folders">
          {FOLDERS.map(x => {
            const c = cnt(x)
            return <div key={x} role="tab" tabIndex={0} aria-selected={x === folder} className={`mi ${x === folder ? 'on' : ''}`}
              onClick={() => { setFolder(x); setSelId(null); setSel(null) }} onKeyDown={e => { if (e.key === 'Enter') { setFolder(x); setSelId(null); setSel(null) } }}>
              <span className="fl">{x}</span>{c.unread ? <span className="pill ac">{c.unread}</span> : <small className="mu">{c.total || ''}</small>}
            </div>
          })}
          <div className="hint">Mails between colleagues stay inside Azcentrix Connect. External mail is sent through your company’s connected mailbox. <a onClick={() => navigate('/settings')}>Set up →</a></div>
        </div>
        <div className="ml">
          {items == null ? <div className="empty">Loading…</div> : items.length ? items.map(e => (
            <div key={e.id} role="button" tabIndex={0} className={`mi ${e.is_read ? '' : 'un'} ${shownId === e.id ? 'on' : ''}`}
              onClick={() => setSelId(e.id)} onKeyDown={ev => { if (ev.key === 'Enter') setSelId(e.id) }}>
              <div className="row" style={{ gap: 6 }}>
                <b className="fl ell">{isOut(e) ? `To: ${first(e.to) || '(no recipient)'}` : e.from_name}</b>
                <small className="mu">{e.folder === 'Drafts' ? 'Draft' : mailTime(e.time, e.folder === 'Scheduled')}</small>
                <button type="button" className={`star ${e.is_starred ? 'on' : ''}`} aria-label={e.is_starred ? 'Unstar' : 'Star'} title={e.is_starred ? 'Unstar' : 'Star'}
                  onClick={ev => { ev.stopPropagation(); star(e) }}>{e.is_starred ? '★' : '☆'}</button>
              </div>
              <div className="ell subj">{e.subject}</div>
              <div className="row" style={{ gap: 4, marginTop: 2 }}>
                <small className="mu fl ell">{e.preview.slice(0, 60)}</small>
                {e.is_internal && <span className="pill mu">Internal</span>}
                {e.link && <span className="pill ac">{e.link.ref.slice(0, 9)}</span>}
                {e.attachments > 0 && <Ic n="doc" />}
              </div>
            </div>
          )) : <div className="empty">Nothing in {folder}</div>}
        </div>
        <div className="mread">
          {sel ? <Reader m={sel} busy={busy}
            onReply={all => setCompose(replyInit(sel, all))} onForward={() => setCompose(forwardInit(sel))} onEdit={() => setCompose(editInit(sel))}
            onArchive={() => move(sel, sel.folder === 'Archive' ? 'Inbox' : 'Archive')} onTrash={() => trash(sel)} onRestore={() => restore(sel)}
            onLink={() => setLinkFor(sel)} onTask={() => task(sel)} onLead={() => lead(sel)} onUnread={() => unreadOne(sel)} onAssign={() => setAssignFor(sel)}
            onCancelSchedule={() => cancelSchedule(sel)} onOpenRecord={r => navigate(r)} onSelect={id => setSelId(id)} />
            : <div className="empty">{items?.length === 0 ? '' : shownId ? 'Loading…' : 'Select a message'}</div>}
        </div>
      </div>
      {compose && <ComposeModal init={compose} mailbox={mailbox} onClose={() => setCompose(null)} onDone={afterCompose} />}
      {linkFor && <LinkModal m={linkFor} onClose={() => setLinkFor(null)} onLinked={d => { setLinkFor(null); setSel(d); load(); success('Email linked – it now shows on the record timeline') }} />}
      {assignFor && <AssignModal m={assignFor} onClose={() => setAssignFor(null)} onDone={n => { setAssignFor(null); success(`Assigned to ${n}`); load() }} />}
    </div>
  )
}

function Reader({ m, busy, onReply, onForward, onEdit, onArchive, onTrash, onRestore, onLink, onTask, onLead, onUnread, onAssign, onCancelSchedule, onOpenRecord, onSelect }: {
  m: MailDetail; busy: string | null; onReply: (all: boolean) => void; onForward: () => void; onEdit: () => void; onArchive: () => void; onTrash: () => void; onRestore: () => void
  onLink: () => void; onTask: () => void; onLead: () => void; onUnread: () => void; onAssign: () => void; onCancelSchedule: () => void; onOpenRecord: (route: string) => void; onSelect: (id: number) => void
}) {
  const draft = m.folder === 'Drafts', sched = m.folder === 'Scheduled', trashF = m.folder === 'Trash'
  const link = m.link
  return <>
    <div className="row mb" style={{ flexWrap: 'wrap' }}>
      <h2 className="fl" style={{ margin: 0 }}>{m.subject}</h2>
      {draft || sched ? <>
        <button type="button" className="btn s" onClick={onEdit}><Ic n="edit" /> Edit {sched ? 'message' : 'draft'}</button>
        {sched && <button type="button" className="btn s" disabled={busy === 'unsched'} onClick={onCancelSchedule}>Cancel schedule</button>}
      </> : <>
        <button type="button" className="btn s" onClick={() => onReply(false)}><Ic n="left" /> Reply</button>
        <button type="button" className="btn s" onClick={() => onReply(true)}>Reply all</button>
        <button type="button" className="btn s" onClick={onForward}>Forward</button>
        {trashF ? <button type="button" className="btn s" disabled={busy === 'restore'} onClick={onRestore}>Restore</button>
          : <button type="button" className="btn s" disabled={busy === 'move'} onClick={onArchive}>{m.folder === 'Archive' ? 'Move to Inbox' : 'Archive'}</button>}
      </>}
      <button type="button" className="btn s d" disabled={busy === 'trash'} onClick={onTrash} title={trashF ? 'Delete forever' : 'Move to Trash'} aria-label={trashF ? 'Delete forever' : 'Move to Trash'}><Ic n="trash" /></button>
    </div>
    <div className="row mb" style={{ gap: 8 }}>
      <Avatar name={(m.from_name || '?').replace(/\s*\(.*\)$/, '')} />
      <div className="fl" style={{ minWidth: 0 }}><b>{m.from_name}</b> <small className="mu">&lt;{m.from_email}&gt;</small><br />
        <small className="mu">to {m.to || 'me'}{m.cc ? ` · cc ${m.cc}` : ''}{m.bcc ? ` · bcc ${m.bcc}` : ''} · {draft ? 'Draft' : mailTime(m.time, sched)}</small></div>
      {m.is_internal ? <span className="pill mu">Internal</span> : <span className="pill inf">External</span>}
    </div>
    <div className="row mb" style={{ flexWrap: 'wrap', gap: 6 }}>
      {link ? <span className="chip on"><Ic n="link" /> {link.type} · <a onClick={() => onOpenRecord(m.record?.route || link.route)}>{link.ref}</a></span>
        : <button type="button" className="btn s" onClick={onLink}><Ic n="link" /> Link to a record</button>}
      {m.account && m.account !== '—' && <span className="chip"><Ic n="building" /> {m.account}</span>}
      <button type="button" className="btn s" disabled={busy === 'task'} onClick={onTask}><Ic n="check" /> Create task</button>
      {m.can_create_lead && <button type="button" className="btn s" disabled={busy === 'lead'} onClick={onLead}>Create lead</button>}
      {!draft && !sched && <button type="button" className="btn s" disabled={busy === 'unread'} onClick={onUnread}>Mark unread</button>}
      {!draft && !sched && <button type="button" className="btn s" onClick={onAssign}>Assign to colleague</button>}
      {m.assigned_to && <small className="mu">Assigned to {m.assigned_to}</small>}
    </div>
    <div className="body">{m.body}</div>
    {m.attachment_list.length > 0 && <div className="row wrap mt" style={{ gap: 6 }}>
      {m.attachment_list.map(a => a.url
        ? <a key={a.id} className="chip" href={a.url} target="_blank" rel="noopener noreferrer"><Ic n="doc" /> {a.name} <small className="mu">{fmtSize(a.size_kb)}</small></a>
        : <span key={a.id} className="chip"><Ic n="doc" /> {a.name} <small className="mu">{fmtSize(a.size_kb)}</small></span>)}
    </div>}
    {m.folder === 'Sent' && !m.is_internal && m.delivery_status === 'sent' && <div className="note inf mt">Tracking: {m.track_opens ? `opened ${m.open_count}× · ${m.click_count} clicks` : 'off for this message'}</div>}
    {m.folder === 'Sent' && (m.delivery_status === 'failed' || m.delivery_status === 'not_configured') && <div className="note bad mt">Not delivered to external recipients: {m.delivery_error || 'mail server error'}</div>}
    {sched && m.scheduled_at && <div className="note inf mt">Scheduled to send {mailTime(m.scheduled_at, true)}</div>}
    {m.thread.length > 0 && <>
      <h3 className="mt mb">Thread ({m.thread.length} more)</h3>
      {m.thread.map(x => <div key={x.id} className="thr" role="button" tabIndex={0} onClick={() => onSelect(x.id)} onKeyDown={e => { if (e.key === 'Enter') onSelect(x.id) }}>
        <b>{x.from_name}</b> <small className="mu">{mailTime(x.time)}</small><br /><small>{x.preview.slice(0, 100)}</small>
      </div>)}
    </>}
  </>
}

// Prototype mailLink(): "Link email to a record" – Bid / Deal / Customer / Quote (+ Lead) options.
function LinkModal({ m, onClose, onLinked }: { m: MailDetail; onClose: () => void; onLinked: (d: MailDetail) => void }) {
  const { error } = useToast()
  const [q, setQ] = useState('')
  const [opts, setOpts] = useState<CrmRecord[] | null>(null)
  const [val, setVal] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => inboxApi.records(q).then(L => { setOpts(L); setVal(v => L.some(r => `${r.module}|${r.id}` === v) ? v : L[0] ? `${L[0].module}|${L[0].id}` : '') }).catch(() => setOpts([])), q ? 250 : 0)
    return () => window.clearTimeout(t)
  }, [q])
  const save = async () => {
    const [mod, id] = val.split('|')
    if (!mod) return
    setSaving(true)
    try { onLinked(await inboxApi.link(m.id, mod, Number(id))) } catch (e) { error(errMsg(e, 'Could not link the email')) } finally { setSaving(false) }
  }
  return <Modal title="Link email to a record" width={460} onClose={onClose}
    foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={!val || saving} onClick={save}>Link</button></>}>
    <input className="in mb" placeholder="Search bids, deals, customers, quotes, leads…" value={q} onChange={e => setQ(e.target.value)} aria-label="Search records" />
    <select className="in" value={val} onChange={e => setVal(e.target.value)} aria-label="Record">
      {opts == null ? <option>Loading…</option> : opts.length ? opts.map(r => <option key={`${r.module}|${r.id}`} value={`${r.module}|${r.id}`}>{r.label}</option>) : <option value="">No records found</option>}
    </select>
  </Modal>
}

// Prototype mailAssign(): colleague select + "Add an internal note".
function AssignModal({ m, onClose, onDone }: { m: MailDetail; onClose: () => void; onDone: (name: string) => void }) {
  const { error } = useToast()
  const [people, setPeople] = useState<People['colleagues'] | null>(null)
  const [uid, setUid] = useState('')
  const [note, setNote] = useState(true)
  const [saving, setSaving] = useState(false)
  const me = String((useAuthStore() as any).user?.email || '').toLowerCase()
  useEffect(() => { inboxApi.people().then(p => { const L = p.colleagues; setPeople(L); setUid(String(L.find(u => u.email.toLowerCase() !== me)?.id ?? '')) }).catch(() => setPeople([])) }, [me])
  const save = async () => {
    setSaving(true)
    try { const r = await inboxApi.assign(m.id, Number(uid), note); onDone(r.assigned_to) } catch (e) { error(errMsg(e, 'Could not assign')) } finally { setSaving(false) }
  }
  return <Modal title="Assign to a colleague" width={400} onClose={onClose}
    foot={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn p" disabled={!uid || saving} onClick={save}>Assign</button></>}>
    <select className="in" value={uid} onChange={e => setUid(e.target.value)} aria-label="Colleague">
      {people == null ? <option>Loading…</option> : people.map(u => <option key={u.id} value={u.id}>{u.name} · {u.designation || u.role}</option>)}
    </select>
    <label className="row mt"><input type="checkbox" checked={note} onChange={e => setNote(e.target.checked)} /> Add an internal note</label>
  </Modal>
}
