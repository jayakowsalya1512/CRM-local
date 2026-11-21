// Calendar & Tasks – "+ New task" / edit form and the task detail view (prototype .ov / .md modal).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '../notifications/Modal'
import FieldError from '@/components/form/FieldError'
import { useModalValidation } from '@/components/form/useModalValidation'
import { todayISO, type FieldSpec } from '@/utils/validation'
import {
  PRIORITIES, STATUSES, calApi, dto, errMsg, fd, pc,
  type Meta, type Priority, type Related, type Task, type TaskInput, type TaskStatus,
} from './calendarApi'

// prototype av(): initials on a colour picked from the name
const PAL = ['#0F6E8C', '#B26B00', '#1B8559', '#7A4DB8', '#C13B2A', '#3E63A8', '#6B7D2A', '#B0447A']
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }
export function Av({ name }: { name: string }) {
  const n = name || '?'
  return <span className="av" style={{ background: PAL[hash(n) % PAL.length] }} title={n}>{n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}</span>
}
export const Pill = ({ s }: { s: string }) => <span className={`pill ${pc(s)}`}>{s}</span>
// prototype dueCell(); `bare` drops the "in 3d" hint like the task board does
export function Due({ d, today, bare }: { d: string | null; today: string; bare?: boolean }) {
  if (!d) return <>—</>
  const n = dto(d, today)
  return <span className={n < 0 ? 'tbad' : n <= 7 ? 'twarn' : ''}>{fd(d)}{!bare && <> <small>{n < 0 ? `${-n}d ago` : n === 0 ? 'today' : `in ${n}d`}</small></>}</span>
}

// ─── New / edit task ──────────────────────────────────────────────────────────

export function TaskForm({ meta, task, onClose, onSaved }: { meta: Meta; task?: Task | null; onClose: () => void; onSaved: (t: Task) => void }) {
  const { success, error } = useToast()
  const [v, setV] = useState<TaskInput>(() => task
    ? { title: task.title, due: task.due || '', priority: task.priority, status: task.status, assignee_id: task.assignee_id, related_module: task.related_module, related_id: task.related_id }
    : { title: '', due: '', priority: 'Medium', status: 'To do', assignee_id: meta.me.id, related_module: null, related_id: null })
  const [relLabel, setRelLabel] = useState(task?.related || '')
  const [relQ, setRelQ] = useState('')
  const [relOpen, setRelOpen] = useState(false)
  const [rel, setRel] = useState<Related[] | null>(null)
  const [busy, setBusy] = useState(false)
  // new tasks cannot be due in the past; an existing task keeps its (possibly overdue) date unless it is changed
  const origDue = task?.due || ''
  const specs = (x: TaskInput): Record<string, FieldSpec> => ({
    title: { label: 'Task title', rule: 'text', required: true, min: 2, max: 300 },
    due: { label: 'Due date', rule: 'date', required: true, ...(x.due && x.due === origDue ? {} : { minDate: todayISO(), dateLabel: { min: 'today' } }) },
  })
  const fv = useModalValidation(v, specs, undefined, { title: 'tk-title', due: 'tk-due' })
  const errs = fv.errors
  const titleRef = useRef<HTMLInputElement>(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  useEffect(() => {
    if (!relOpen) return
    const t = setTimeout(() => { calApi.related(relQ).then(setRel).catch(() => setRel([])) }, relQ ? 250 : 0)
    return () => clearTimeout(t)
  }, [relQ, relOpen])

  const set = <K extends keyof TaskInput>(k: K, val: TaskInput[K]) => { const next = { ...v, [k]: val }; setV(next); fv.change(next, k as string) }
  const save = async () => {
    if (!fv.submit()) return
    setBusy(true)
    try {
      const body = { ...v, title: v.title.trim() }
      const saved = task ? await calApi.update(task.id, body) : await calApi.create(body)
      success(task ? 'Task updated' : 'Task created')
      onSaved(saved)
    } catch (x) { if (!fv.server(x)) error(errMsg(x, task ? 'Could not update the task' : 'Could not create the task')) }
    finally { setBusy(false) }
  }

  return (
    <Modal title={task ? 'Edit task' : 'New task'} onClose={onClose} foot={<>
      <span className="fl" />
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="button" className="btn p" onClick={save} disabled={busy}>{busy ? 'Saving…' : task ? 'Save changes' : 'Create task'}</button>
    </>}>
      <form className="fg" onSubmit={e => { e.preventDefault(); void save() }}>
        <div className="f1">
          <label htmlFor="tk-title">Task title <b>*</b></label>
          <input id="tk-title" ref={titleRef} className={`in ${errs.title ? 'bad err' : ''}`} maxLength={300} value={v.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Finalise bid documents" {...fv.aria('title')} />
          <FieldError id="tk-title" msg={errs.title} />
        </div>
        <div className="f1">
          <label htmlFor="tk-rel">Related CRM record</label>
          {v.related_id && !relOpen
            ? <div className="row"><span className="chip on" style={{ maxWidth: '100%' }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{relLabel}</span> <a role="button" aria-label="Remove related record" onClick={() => { setV(x => ({ ...x, related_module: null, related_id: null })); setRelLabel('') }}>×</a></span>
              <button type="button" className="btn s g" onClick={() => setRelOpen(true)}>Change</button></div>
            : <>
              <input id="tk-rel" className="in" placeholder="Search bids, deals, leads, customers, quotes, guarantees, orders, trips…" value={relQ}
                onFocus={() => setRelOpen(true)} onChange={e => { setRelQ(e.target.value); setRelOpen(true) }} />
              {relOpen && <div className="rel-list" role="listbox">
                {rel === null ? <div className="mu">Searching…</div> : rel.length === 0 ? <div className="mu">No matching records you can access</div>
                  : rel.map(r => <div key={`${r.module}:${r.id}`} role="option" aria-selected={v.related_module === r.module && v.related_id === r.id}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => { setV(x => ({ ...x, related_module: r.module, related_id: r.id })); setRelLabel(r.label); setRelOpen(false); setRelQ('') }}>
                    <span className="pill mu">{r.type}</span><span className="fl" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.ref} – {r.customer || r.title}</span></div>)}
              </div>}
            </>}
        </div>
        <div>
          <label htmlFor="tk-as">Assignee</label>
          <select id="tk-as" className="in" value={v.assignee_id ?? ''} onChange={e => set('assignee_id', e.target.value ? Number(e.target.value) : null)}>
            <option value="">Unassigned</option>
            {meta.people.map(p => <option key={p.id} value={p.id}>{p.name}{p.id === meta.me.id ? ' (me)' : ''}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="tk-pr">Priority</label>
          <select id="tk-pr" className="in" value={v.priority} onChange={e => set('priority', e.target.value as Priority)}>{PRIORITIES.map(p => <option key={p}>{p}</option>)}</select>
        </div>
        <div>
          <label htmlFor="tk-due">Due date <b>*</b></label>
          <input id="tk-due" type="date" className={`in ${errs.due ? 'bad err' : ''}`} value={v.due} onChange={e => set('due', e.target.value)} {...fv.aria('due')} />
          <FieldError id="tk-due" msg={errs.due} />
        </div>
        <div>
          <label htmlFor="tk-st">Status</label>
          <select id="tk-st" className="in" value={v.status} onChange={e => set('status', e.target.value as TaskStatus)}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

// ─── View task ────────────────────────────────────────────────────────────────

export function TaskView({ id, meta, onClose, onEdit, onChanged }: { id: number; meta: Meta; onClose: () => void; onEdit: (t: Task) => void; onChanged: () => void }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const [t, setT] = useState<Task | null>(null)
  const [missing, setMissing] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => { calApi.get(id).then(setT).catch(e => setMissing(errMsg(e, 'Task not found'))) }, [id])

  const status = async (s: TaskStatus) => {
    if (!t) return
    setBusy(true)
    try { setT(await calApi.status(t.id, s)); success(`Moved to ${s}`); onChanged() }
    catch (e) { error(errMsg(e, 'Could not change the status')) }
    finally { setBusy(false) }
  }
  const del = async () => {
    if (!t) return
    setBusy(true)
    try { await calApi.remove(t.id); success('Task deleted'); onChanged(); onClose() }
    catch (e) { error(errMsg(e, 'Could not delete the task')); setBusy(false) }
  }

  return (
    <Modal title={t ? t.title : 'Task'} onClose={onClose} foot={t && <>
      {t.can_delete && (confirmDel
        ? <><button type="button" className="btn d" onClick={del} disabled={busy}>Confirm delete</button><button type="button" className="btn g" onClick={() => setConfirmDel(false)}>Keep</button></>
        : <button type="button" className="btn d" onClick={() => setConfirmDel(true)}><Ic n="trash" /> Delete</button>)}
      <span className="fl" />
      <button type="button" className="btn" onClick={onClose}>Close</button>
      {t.can_edit && <button type="button" className="btn p" onClick={() => onEdit(t)}><Ic n="edit" /> Edit</button>}
    </>}>
      {missing ? <div className="empty">{missing}</div> : !t ? <div className="empty">Loading…</div> :
        <div className="kv">
          <span>Related</span>
          <span>{t.related ? (t.related_route ? <a onClick={() => { onClose(); navigate(t.related_route!) }}>{t.related}</a> : t.related) : '—'}</span>
          <span>Assignee</span><span className="row" style={{ gap: 6 }}>{t.assignee ? <><Av name={t.assignee} /> {t.assignee}</> : 'Unassigned'}</span>
          <span>Priority</span><span><Pill s={t.priority} /></span>
          <span>Due</span><span><Due d={t.due} today={meta.today} /></span>
          <span>Status</span>
          <span>{t.can_edit
            ? <select className="in sm" style={{ width: 150 }} value={t.status} disabled={busy} aria-label="Change status" onChange={e => status(e.target.value as TaskStatus)}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select>
            : <Pill s={t.status} />}</span>
          <span>Created by</span><span>{t.created_by || '—'}{t.created_at && <small> · {fd(t.created_at)}</small>}</span>
          {t.completed_at && <><span>Completed</span><span>{fd(t.completed_at)}</span></>}
        </div>}
    </Modal>
  )
}
