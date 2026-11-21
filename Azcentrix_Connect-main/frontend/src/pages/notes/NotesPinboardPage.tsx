// Notes & Pinboard – Bidwise prototype v17 → Application → Notes & Pinboard (R.sticky).
// Header: crumb Workspace · "Sticky notes" · company context · + New note; a four-column grid of sticky notes
// (pinned first) with five colour dots, Pin, Delete, inline editing (saved when editing finishes) and the linked record.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { Modal } from '../notifications/Modal'
import { COLOR_NAME, NOTES_CHANGED, NOTE_COLORS, errMsg, notesApi, type Note, type NoteColor } from './notesApi'
import '../notifications/inbox.css'
import './notes.css'

// prototype: L.slice().sort((a,b)=>b.pin-a.pin) – pinned first, otherwise newest first
const order = (L: Note[]) => L.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned))

export default function NotesPinboardPage() {
  const { success, error } = useToast()
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [context, setContext] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [focusId, setFocusId] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<Note | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(() => {
    notesApi.list().then(d => { setNotes(d.items); setContext(d.context); setLoadErr('') })
      .catch(e => { setLoadErr(errMsg(e, 'Could not load your notes')); setNotes(n => n ?? []) })
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { window.addEventListener(NOTES_CHANGED, load); return () => window.removeEventListener(NOTES_CHANGED, load) }, [load])

  const replace = (n: Note) => setNotes(L => L && order(L.map(x => x.id === n.id ? n : x)))

  const add = async () => {
    setAdding(true)
    try { const n = await notesApi.create({ source: 'page', color: 'yellow' }); setNotes(L => order([n, ...(L || [])])); setFocusId(n.id) }
    catch (e) { error(errMsg(e, 'Could not create the note')) }
    finally { setAdding(false) }
  }
  const color = async (n: Note, c: NoteColor, hex: string) => {
    if (n.color === c) return
    const prev = n
    replace({ ...n, color: c, hex })                       // background changes immediately
    try { replace(await notesApi.update(n.id, { color: c })) }
    catch (e) { replace(prev); error(errMsg(e, 'Could not change the colour')) }
  }
  const pin = async (n: Note) => {
    const prev = n
    replace({ ...n, pinned: !n.pinned })
    try { replace(await notesApi.update(n.id, { pinned: !n.pinned })) }
    catch (e) { replace(prev); error(errMsg(e, n.pinned ? 'Could not unpin the note' : 'Could not pin the note')) }
  }
  const save = async (n: Note, html: string): Promise<boolean> => {
    try { replace(await notesApi.update(n.id, { content: html })); return true }
    catch (e) { error(errMsg(e, 'Could not save the note – your previous text was restored')); return false }
  }
  const del = async () => {
    if (!confirm) return
    setDeleting(true)
    try { await notesApi.remove(confirm.id); setNotes(L => L && L.filter(x => x.id !== confirm.id)); success('Note deleted'); setConfirm(null) }
    catch (e) { error(errMsg(e, 'Could not delete the note')) }
    finally { setDeleting(false) }
  }

  return (
    <div className="bwi">
      <div className="pg">
        <div><div className="crumb">Workspace</div><h1>Sticky notes</h1></div>
        <span className="cnt">{context || ''}</span>
        <span className="fl" />
        <button type="button" className="btn p" onClick={add} disabled={adding}><Ic n="plus" /> New note</button>
      </div>
      {loadErr && <div className="note bad mb">{loadErr} <a onClick={load}>Retry</a></div>}
      {notes === null ? <div className="empty">Loading…</div> :
        <div className="g g4">
          {notes.map(n => <StickyNote key={n.id} n={n} autoFocus={focusId === n.id} onFocused={() => setFocusId(null)}
            onColor={(c, hex) => color(n, c, hex)} onPin={() => pin(n)} onDelete={() => setConfirm(n)} onSave={html => save(n, html)} />)}
        </div>}
      {confirm && <Modal title="Delete note?" width={420} onClose={() => !deleting && setConfirm(null)} foot={<>
        <span className="fl" />
        <button type="button" className="btn" onClick={() => setConfirm(null)} disabled={deleting}>Cancel</button>
        <button type="button" className="btn d" onClick={del} disabled={deleting}><Ic n="trash" /> {deleting ? 'Deleting…' : 'Delete'}</button>
      </>}>
        <p style={{ margin: 0 }}>This note will be removed from Notes &amp; Pinboard. This can't be undone.</p>
        <div className="sn" style={{ background: confirm.hex, minHeight: 0, marginTop: 10, boxShadow: 'none' }}><div className="snt" dangerouslySetInnerHTML={{ __html: confirm.content }} /></div>
      </Modal>}
    </div>
  )
}

function StickyNote({ n, autoFocus, onFocused, onColor, onPin, onDelete, onSave }: {
  n: Note; autoFocus: boolean; onFocused: () => void; onColor: (c: NoteColor, hex: string) => void; onPin: () => void; onDelete: () => void; onSave: (html: string) => Promise<boolean>
}) {
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)
  const saved = useRef(n.content)
  const editing = useRef(false)
  const [busy, setBusy] = useState(false)

  // Uncontrolled editor: take the server's content unless the user is typing in this note.
  useLayoutEffect(() => {
    if (ref.current && !editing.current && ref.current.innerHTML !== n.content) ref.current.innerHTML = n.content
    if (!editing.current) saved.current = n.content
  }, [n.content])
  useEffect(() => {
    if (!autoFocus || !ref.current) return
    const el = ref.current
    el.focus()
    const r = document.createRange(); r.selectNodeContents(el)          // "New note…" selected: typing replaces it
    const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r)
    onFocused()
  }, [autoFocus, onFocused])

  const finish = async () => {
    const el = ref.current
    editing.current = false
    if (!el) return
    const html = el.innerHTML
    if (html === saved.current) return
    if (!el.innerText.trim()) { el.innerHTML = saved.current; return }   // a blank note is never saved – the previous text simply comes back
    setBusy(true)
    const ok = await onSave(html)
    setBusy(false)
    if (ok) saved.current = html
    else el.innerHTML = saved.current
  }

  return (
    <div className={`sn ${busy ? 'saving' : ''}`} style={{ background: n.hex }} data-note={n.id}>
      <div className="row" style={{ gap: 4 }}>
        {NOTE_COLORS.map(([c, hex]) => <span key={c} className="snc" role="button" tabIndex={0} aria-label={`${COLOR_NAME[c]} note`} aria-pressed={n.color === c} title={COLOR_NAME[c]}
          style={{ background: hex }} onClick={() => onColor(c, hex)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onColor(c, hex) } }} />)}
        <span className="fl" />
        <button type="button" className={`btn g s snb ${n.pinned ? 'on' : ''}`} onClick={onPin} title={n.pinned ? 'Unpin' : 'Pin'} aria-label={n.pinned ? 'Unpin note' : 'Pin note'} aria-pressed={n.pinned}><Ic n="pin" /></button>
        <button type="button" className="btn g s snb" onClick={onDelete} title="Delete" aria-label="Delete note"><Ic n="trash" /></button>
      </div>
      <div ref={ref} className="snt" contentEditable suppressContentEditableWarning spellCheck={false} role="textbox" aria-multiline aria-label="Note text"
        onFocus={() => { editing.current = true }} onBlur={() => { void finish() }}
        onKeyDown={e => { if (e.key === 'Escape') { (e.currentTarget as HTMLDivElement).blur() } }} />
      <small className="snl">{n.link
        ? <>Linked: {n.link.route ? <a onClick={() => navigate(n.link!.route!)}>{n.link.label}</a> : <span title="You no longer have access to this record">{n.link.label}</span>}</>
        : 'Not linked to a record'}</small>
    </div>
  )
}
