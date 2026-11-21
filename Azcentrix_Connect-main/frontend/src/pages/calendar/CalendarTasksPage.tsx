// Calendar & Tasks – Bidwise prototype v17 → Application → Calendar & Tasks (R.calendar).
// Header (crumb Home · "Calendar & tasks" · Sync calendar · + New task) and one panel with the tabs
// Calendar | Task board | Task list. All data comes from /api/v1/calendar.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '../notifications/Modal'
import { Av, Due, Pill, TaskForm, TaskView } from './TaskModals'
import { STATUSES, ago, calApi, errMsg, iso, type CalEvent, type ListParams, type Meta, type SyncStatus, type Task, type TaskStatus } from './calendarApi'
import '../notifications/inbox.css'
import './calendar.css'

// prototype EVT colours
const EVC: Record<string, string> = {
  bid: 'var(--bw-ba)', prebid: 'var(--bw-wa)', bg: '#7A4DB8', lead: 'var(--bw-in)', trip: 'var(--bw-ok)', task: 'var(--bw-ac)', order: '#B0447A',
}
const TABS = ['Calendar', 'Task board', 'Task list'] as const
type Tab = typeof TABS[number]
const store = {
  get: <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : d } catch { return d } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* private mode */ } },
}

export default function CalendarTasksPage() {
  const [params, setParams] = useSearchParams()
  const { success, error, warning, info } = useToast()
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaErr, setMetaErr] = useState('')
  const [tab, setTab] = useState<Tab>(() => { const t = store.get<string>('cal:tab', 'Calendar'); return (TABS as readonly string[]).includes(t) ? t as Tab : 'Calendar' })
  const [rev, setRev] = useState(0)                                   // bump → calendar, board and list reload
  const [form, setForm] = useState<{ task: Task | null } | null>(null)
  const [viewId, setViewId] = useState<number | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [syncing, setSyncing] = useState(false)
  const changed = useCallback(() => setRev(r => r + 1), [])

  useEffect(() => { calApi.meta().then(m => { setMeta(m); setSync(m.sync) }).catch(e => setMetaErr(errMsg(e, 'Could not load Calendar & Tasks'))) }, [])
  useEffect(() => { store.set('cal:tab', tab) }, [tab])

  const runSync = useCallback(async () => {
    setSyncing(true)
    try {
      const r = await calApi.sync()
      if (r.status === 'needs_auth') {
        if (r.sync) setSync(r.sync)
        info(`${r.message} – opening Google…`)
        window.location.assign(r.auth_url)
        return
      }
      setSync(r.sync)
      const c = r.counts
      const msg = `Synced with Google Calendar · ${c.created} added, ${c.updated} updated, ${c.deleted} removed${c.unchanged ? `, ${c.unchanged} unchanged` : ''}`
      if (r.status === 'partial') warning(msg, `${c.failed} failed: ${r.errors[0] || ''}`)
      else success(msg)
    } catch (e) {
      error(errMsg(e, 'Calendar sync failed'))
      calApi.syncStatus().then(setSync).catch(() => {})
    } finally { setSyncing(false) }
  }, [success, error, warning, info])

  // deep links: ?task=ID (notifications, Inbox "Create task") and the Google consent return (?gcal=…)
  useEffect(() => {
    const t = params.get('task'), g = params.get('gcal')
    if (!t && !g) return
    if (t && Number(t)) setViewId(Number(t))
    if (g === 'connected') { success('Google Calendar connected'); void runSync() }
    else if (g === 'denied') error('Google Calendar access was not granted')
    else if (g === 'failed') error('Could not connect Google Calendar – try again')
    else if (g === 'invalid') error('The Google sign-in link was invalid or expired – try Sync calendar again')
    const next = new URLSearchParams(params); next.delete('task'); next.delete('gcal')
    setParams(next, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const syncLine = !sync ? null
    : sync.status === 'not_configured' ? <span className="syncst">Google Calendar sync is not configured for this workspace</span>
      : sync.status === 'auth_failed' ? <span className="syncst bad">Google Calendar access expired{sync.account ? ` (${sync.account})` : ''} – Sync calendar to reconnect</span>
        : !sync.connected ? <span className="syncst">Google Calendar not connected</span>
          : <span className={`syncst ${sync.last_status === 'failed' || sync.last_status === 'partial' ? 'bad' : ''}`} title={sync.last_message || ''}>
            Google Calendar{sync.account ? ` · ${sync.account}` : ''} · {sync.last_sync_at ? `last synced ${ago(sync.last_sync_at)}${sync.last_status === 'partial' ? ' (some events failed)' : sync.last_status === 'failed' ? ' (failed)' : ''}` : 'not synced yet'}
          </span>

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">Home</div><h1>Calendar &amp; tasks</h1></div>
        <span className="fl" />
        {syncLine}
        <button type="button" className="btn" onClick={runSync} disabled={syncing || !meta} title={sync?.status === 'not_configured' ? 'Google Calendar sync is not configured' : 'Sync with Google Calendar'}>
          <Ic n="cal" /> {syncing ? 'Syncing…' : 'Sync calendar'}
        </button>
        <button type="button" className="btn p" onClick={() => setForm({ task: null })} disabled={!meta?.can.create} title={meta && !meta.can.create ? "You don't have permission to create tasks" : undefined}>
          <Ic n="plus" /> New task
        </button>
      </div>
      {metaErr ? <div className="panel"><div className="empty">{metaErr}</div></div> : !meta ? <div className="panel"><div className="empty">Loading…</div></div> :
        <div className="panel">
          <div className="tabs" role="tablist">
            {TABS.map(t => <div key={t} role="tab" tabIndex={0} aria-selected={t === tab} className={`tab ${t === tab ? 'on' : ''}`} onClick={() => setTab(t)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(t) } }}>{t}</div>)}
          </div>
          <div className={`pb ${tab === 'Task list' ? 'z' : ''}`}>
            {tab === 'Calendar' ? <MonthView meta={meta} rev={rev} onTask={setViewId} />
              : tab === 'Task board' ? <Board meta={meta} rev={rev} onOpen={setViewId} onChanged={changed} />
                : <TaskList meta={meta} rev={rev} onOpen={setViewId} onChanged={changed} />}
          </div>
        </div>}
      {form && meta && <TaskForm meta={meta} task={form.task} onClose={() => setForm(null)} onSaved={t => { setForm(null); changed(); if (form.task) setViewId(t.id) }} />}
      {viewId && meta && !form && <TaskView id={viewId} meta={meta} onClose={() => setViewId(null)} onChanged={changed}
        onEdit={t => { setViewId(null); setForm({ task: t }) }} />}
    </div>
  )
}

// ─── Calendar (month grid) ────────────────────────────────────────────────────

function MonthView({ meta, rev, onTask }: { meta: Meta; rev: number; onTask: (id: number) => void }) {
  const navigate = useNavigate()
  const { error } = useToast()
  const [cm, setCm] = useState(() => store.get<number>('cal:cm', 0))
  const [flt, setFlt] = useState<Set<string>>(() => new Set(store.get<string[]>('cal:flt', meta.event_types.map(e => e.key))))
  const [events, setEvents] = useState<CalEvent[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [day, setDay] = useState<string | null>(null)
  useEffect(() => { store.set('cal:cm', cm) }, [cm])
  useEffect(() => { store.set('cal:flt', [...flt]) }, [flt])

  const today = meta.today
  const { base, cells, mo } = useMemo(() => {
    const t = new Date(`${today}T00:00:00`)
    const b = new Date(t.getFullYear(), t.getMonth() + cm, 1)
    const off = (b.getDay() + 6) % 7
    const first = new Date(b); first.setDate(1 - off)
    const cs = Array.from({ length: 42 }, (_, i) => { const d = new Date(first); d.setDate(first.getDate() + i); return d })
    return { base: b, cells: cs, mo: b.toLocaleString('en-GB', { month: 'long', year: 'numeric' }) }
  }, [today, cm])
  const start = iso(cells[0]), end = iso(cells[41])

  // one request per visible range; filter chips only filter what is already loaded
  useEffect(() => {
    let live = true
    setBusy(true)
    calApi.events(start, end).then(items => { if (live) setEvents(items) }).catch(e => { if (live) { setEvents([]); error(errMsg(e, 'Could not load calendar events')) } }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [start, end, rev, error])

  const byDay = useMemo(() => {
    const m: Record<string, CalEvent[]> = {}
    for (const e of events || []) if (flt.has(e.type)) (m[e.date] ??= []).push(e)
    return m
  }, [events, flt])
  const open = (e: CalEvent) => { if (e.module === 'calendar') onTask(e.id); else if (e.route) navigate(e.route) }
  const toggle = (k: string) => setFlt(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const Ev = ({ e }: { e: CalEvent }) => <span className="ev" role="button" tabIndex={0} style={{ ['--c' as string]: EVC[e.type] }} title={e.sub ? `${e.title} – ${e.sub}` : e.title}
    onClick={() => open(e)} onKeyDown={k => { if (k.key === 'Enter') open(e) }}>{e.title}</span>

  return <>
    <div className="row mb calbar">
      <button type="button" className="btn s" onClick={() => setCm(c => c - 1)} aria-label="Previous month">‹</button>
      <b className="mo">{mo}</b>
      <button type="button" className="btn s" onClick={() => setCm(c => c + 1)} aria-label="Next month">›</button>
      <button type="button" className="btn s" onClick={() => setCm(0)}>Today</button>
      <span className="fl" />
      {meta.event_types.map(({ key, label }) => {
        const on = flt.has(key)
        return <span key={key} className={`chip ${on ? 'on' : ''}`} role="checkbox" aria-checked={on} tabIndex={0} style={on ? { background: EVC[key], borderColor: EVC[key] } : undefined}
          onClick={() => toggle(key)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key) } }}>{label}</span>
      })}
    </div>
    <div className="cal" aria-busy={busy || events === null}>
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="h">{d}</div>)}
      {cells.map(d => {
        const k = iso(d), L = byDay[k] || []
        return <div key={k} className={`${d.getMonth() !== base.getMonth() ? 'o' : ''} ${k === today ? 'td' : ''}`}>
          <b>{d.getDate()}</b>
          {L.slice(0, 3).map(e => <Ev key={e.key} e={e} />)}
          {L.length > 3 && <small className="more" role="button" tabIndex={0} onClick={() => setDay(k)} onKeyDown={e => { if (e.key === 'Enter') setDay(k) }}>+{L.length - 3} more</small>}
        </div>
      })}
    </div>
    {day && <Modal title={new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} width={460} onClose={() => setDay(null)}>
      {(byDay[day] || []).map(e => <div key={e.key} className="dayev"><span className="ev" role="button" tabIndex={0} style={{ ['--c' as string]: EVC[e.type] }}
        onClick={() => { setDay(null); open(e) }} onKeyDown={k => { if (k.key === 'Enter') { setDay(null); open(e) } }}>{e.title}</span>
        <small>{meta.event_types.find(t => t.key === e.type)?.label}</small></div>)}
    </Modal>}
  </>
}

// ─── Task board ───────────────────────────────────────────────────────────────

function Board({ meta, rev, onOpen, onChanged }: { meta: Meta; rev: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const { success, error } = useToast()
  const [cols, setCols] = useState<{ status: TaskStatus; count: number; items: Task[] }[] | null>(null)
  const [moving, setMoving] = useState<number | null>(null)
  useEffect(() => { calApi.board().then(d => setCols(d.columns)).catch(e => { setCols([]); error(errMsg(e, 'Could not load the task board')) }) }, [rev, error])

  const move = async (t: Task, dir: -1 | 1) => {
    const to = STATUSES[STATUSES.indexOf(t.status) + dir]
    if (!to || !cols) return
    setMoving(t.id)
    // optimistic: move the card and the counts straight away, then confirm from the server
    setCols(cs => cs && cs.map(c => c.status === t.status ? { ...c, count: c.count - 1, items: c.items.filter(x => x.id !== t.id) }
      : c.status === to ? { ...c, count: c.count + 1, items: [{ ...t, status: to }, ...c.items] } : c))
    try { await calApi.status(t.id, to); success(`Moved to ${to}`); onChanged() }
    catch (e) { error(errMsg(e, 'Could not move the task')); onChanged() }
    finally { setMoving(null) }
  }

  if (!cols) return <div className="empty">Loading…</div>
  return <div className="kb">
    {cols.map(c => <div key={c.status} className="kc" style={{ flex: '1 1 280px' }}>
      <h4>{c.status}<small>{c.count}</small></h4>
      <div className="cs">
        {c.items.map(x => <div key={x.id} className="kcard" role="button" tabIndex={0} onClick={() => onOpen(x.id)} onKeyDown={e => { if (e.key === 'Enter') onOpen(x.id) }}>
          <div className="t1">{x.title}</div>
          <small>{x.related || '—'}</small>
          <div className="m">
            <span><Due d={x.due} today={meta.today} bare /> <Pill s={x.priority} /></span>
            <span className="row" style={{ gap: 2 }} onClick={e => e.stopPropagation()}>
              {x.can_edit && c.status !== 'To do' && <button type="button" className="btn g s" disabled={moving === x.id} onClick={() => move(x, -1)} aria-label={`Move back to ${STATUSES[STATUSES.indexOf(c.status) - 1]}`}>‹</button>}
              {x.can_edit && c.status !== 'Done' && <button type="button" className="btn g s" disabled={moving === x.id} onClick={() => move(x, 1)} aria-label={`Move to ${STATUSES[STATUSES.indexOf(c.status) + 1]}`}>›</button>}
              {x.assignee ? <Av name={x.assignee} /> : null}
            </span>
          </div>
        </div>)}
        {c.count > c.items.length && <small className="lim">Showing {c.items.length} of {c.count} – see Task list for all</small>}
      </div>
    </div>)}
  </div>
}

// ─── Task list (prototype gridHTML via BwGrid, server-side) ──────────────────

function TaskList({ meta, rev, onOpen, onChanged }: { meta: Meta; rev: number; onOpen: (id: number) => void; onChanged: () => void }) {
  const { success, error } = useToast()
  const [p, setP] = useState<ListParams>({ offset: 0, limit: 25 })
  const [qf, setQf] = useState<{ q: string; f: Record<string, string> }>({ q: '', f: {} })
  const [data, setData] = useState<{ items: Task[]; total: number; loading: boolean }>({ items: [], total: 0, loading: true })

  const key = JSON.stringify([p, qf, rev])
  useEffect(() => {
    let live = true
    setData(d => ({ ...d, loading: true }))
    const t = setTimeout(() => {
      calApi.list({ ...p, q: qf.q, f: qf.f })
        .then(r => { if (live) setData({ items: r.items, total: r.total, loading: false }) })
        .catch(e => { if (live) { setData({ items: [], total: 0, loading: false }); error(errMsg(e, 'Could not load tasks')) } })
    }, qf.q || Object.values(qf.f).some(Boolean) ? 250 : 0)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = useCallback((s: { q: string; f: Record<string, string> }) => setQf(x => JSON.stringify(x) === JSON.stringify(s) ? x : s), [])
  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][]; adv: ListParams['adv'] }) => setP({ offset: s.offset, limit: s.limit, sorts: s.sorts, adv: s.adv }), [])

  const cols: GridCol<Task>[] = useMemo(() => [
    { k: 'title', t: 'Task', w: 300 },
    { k: 'related', t: 'Related', txt: r => r.related || '' },
    { k: 'assignee', t: 'Assignee', txt: r => r.assignee || '', fn: r => r.assignee ? <span className="row" style={{ gap: 6 }}><Av name={r.assignee} /> {r.assignee}</span> : '—' },
    { k: 'priority', t: 'Priority', w: 118, fn: r => <Pill s={r.priority} /> },
    { k: 'due', t: 'Due', w: 122, date: true, txt: r => r.due || '', fn: r => <Due d={r.due} today={meta.today} /> },
    {
      k: 'status', t: 'Status', w: 118, fn: r => <Pill s={r.status} />,
      ed: { t: 'sel', o: STATUSES, value: r => r.status, save: async (r, v) => {
        if (!r.can_edit) { error("You don't have permission to change this task"); throw new Error('denied') }
        try { await calApi.status(r.id, v as TaskStatus); success(`Moved to ${v}`); onChanged() }
        catch (e) { error(errMsg(e, 'Could not change the status')); throw e }
      } },
    },
  ], [meta.today, success, error, onChanged])

  const bulk = useMemo(() => {
    const run = async (rows: Task[], action: 'status' | 'delete', status?: TaskStatus) => {
      try {
        const r = await calApi.bulk(rows.map(x => x.id), action, status)
        success(action === 'delete' ? `${r.done} task${r.done === 1 ? '' : 's'} deleted${r.skipped ? ` · ${r.skipped} skipped (created by someone else)` : ''}` : `${r.done} task${r.done === 1 ? '' : 's'} moved to ${status}`)
        onChanged()
      } catch (e) { error(errMsg(e, 'Bulk action failed')) }
    }
    const out: [string, (rows: Task[]) => void][] = []
    if (meta.can.update) out.push(['Mark done', rows => void run(rows, 'status', 'Done')], ['Mark in progress', rows => void run(rows, 'status', 'In progress')])
    if (meta.can.delete) out.push(['Delete', rows => { if (window.confirm(`Delete ${rows.length} selected task${rows.length === 1 ? '' : 's'}?`)) void run(rows, 'delete') }])
    return out
  }, [meta.can, success, error, onChanged])

  return <div aria-busy={data.loading}>
    <BwGrid id="calendar-tasks" cols={cols} rows={data.items} rid={r => String(r.id)} onRow={r => onOpen(r.id)} bulk={bulk}
      server={{ total: data.total, onChange: onServer }} onQuery={onQuery}
      empty={data.loading ? 'Loading…' : 'No tasks match the current filters.'} />
  </div>
}
