import { useCallback, useEffect, useRef, useState } from 'react'
import { AlarmClock, Baseline, Bold, Check, ChevronDown, Highlighter, Italic, List, ListOrdered, Loader2, Minus, Strikethrough, Trash2, Type, Underline, X } from 'lucide-react'
import { isAxiosError } from 'axios'
import api, { withPassiveSessionActivity } from '@/services/api'
import './StickyNotes.css'

function PinnedNoteIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <path fill="currentColor" d="M3 9.018V14l.005.176A3 3 0 0 0 6 17h4v-4l.005-.176a3 3 0 0 1 2.819-2.819L13 10h4V6l-.005-.176A3 3 0 0 0 14 3H9.463a2.273 2.273 0 0 1-.74 3.51l-1.892.922l-.442 1.28a1.818 1.818 0 0 1-3.004.691zm13.542 2.635A2 2 0 0 0 16.9 11H13l-.157.006a2 2 0 0 0-1.838 1.845L11 13l.001 3.9c.296-.096.568-.262.792-.486l4.621-4.621zM8.538 3.387L6.611 1.46a1.5 1.5 0 0 0-2.409.404L3.4 3.51a1 1 0 0 1-.573.507l-1.102.38a1 1 0 0 0-.38 1.653l.948.948L1 8.29v.707h.707L3 7.706l.947.947a1 1 0 0 0 1.653-.38l.38-1.102a1 1 0 0 1 .507-.572l1.647-.803a1.5 1.5 0 0 0 .404-2.409" />
    </svg>
  )
}

type Color = 'olive' | 'yellow' | 'pink' | 'green' | 'blue' | 'lavender'
type Note = { id: number; title: string; content: string; color: Color; pinned: boolean; reminder_at: string | null; reminder_sent: boolean; version: number; updated_at: string }

const colors: Color[] = ['olive', 'yellow', 'pink', 'green', 'blue', 'lavender']
const allowed = new Set(['P', 'DIV', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI'])
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$|^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/
const SIZE_RE = /^\d{1,3}px$/
const TEXT_COLORS = ['#f4f4e7', '#ef4444', '#f59e0b', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#64748b']
const HIGHLIGHT_COLORS = ['#fde68a', '#fecaca', '#bbf7d0', '#bfdbfe', '#e9d5ff', '#fed7aa']
const FONT_SIZES: { label: string; value: string }[] = [
  { label: 'Small', value: '13px' },
  { label: 'Normal', value: '17px' },
  { label: 'Large', value: '22px' },
  { label: 'Huge', value: '30px' },
]

function sanitizeSpanStyle(el: HTMLElement) {
  const parts: string[] = []
  if (el.style.color && COLOR_RE.test(el.style.color)) parts.push(`color: ${el.style.color}`)
  if (el.style.backgroundColor && COLOR_RE.test(el.style.backgroundColor)) parts.push(`background-color: ${el.style.backgroundColor}`)
  if (el.style.fontSize && SIZE_RE.test(el.style.fontSize)) parts.push(`font-size: ${el.style.fontSize}`)
  return parts.join('; ')
}

function cleanHTML(html: string) {
  const source = new DOMParser().parseFromString(html, 'text/html')
  const output = document.createElement('div')
  const copy = (node: Node, parent: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.textContent || '')); return }
    if (!(node instanceof Element)) return
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH'].includes(node.tagName)) return
    let target: Node = parent
    if (allowed.has(node.tagName)) {
      target = document.createElement(node.tagName.toLowerCase())
      parent.appendChild(target)
    } else if (node.tagName === 'SPAN') {
      const style = sanitizeSpanStyle(node as HTMLElement)
      if (style) {
        const span = document.createElement('span')
        span.setAttribute('style', style)
        parent.appendChild(span)
        target = span
      }
    }
    node.childNodes.forEach(child => copy(child, target))
  }
  source.body.childNodes.forEach(node => copy(node, output))
  return output.innerHTML
}

function localDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

function errorMessage(error: unknown) {
  const detail = isAxiosError(error) ? error.response?.data?.detail : null
  return typeof detail === 'string' ? detail : 'Could not save. Your changes are still here. Please retry.'
}

export default function StickyNotes({ onOpen }: { onOpen: () => void }) {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('All changes saved')
  const [error, setError] = useState('')
  const [reminderOpen, setReminderOpen] = useState(false)
  const [colorMenuOpen, setColorMenuOpen] = useState(false)
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false)
  const [textColorOpen, setTextColorOpen] = useState(false)
  const [highlightOpen, setHighlightOpen] = useState(false)
  const [reminderDraft, setReminderDraft] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const latest = useRef<Note | null>(null)
  const saved = useRef('')
  const version = useRef(1)
  const drag = useRef<{ startX: number; startY: number; startLeft: number; startTop: number } | null>(null)
  const pending = useRef<Promise<boolean> | null>(null)
  const deletingRef = useRef(false)

  const createNote = useCallback(async () => {
    const { data } = await api.post<Note>('/sticky-notes', { title: 'Untitled note', content: '', color: 'olive' })
    return data
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get<Note[]>('/sticky-notes', withPassiveSessionActivity())
      const next = data[0] ?? await createNote()
      latest.current = next
      saved.current = JSON.stringify(next)
      version.current = next.version
      setNote(next)
      setReminderDraft(localDate(next.reminder_at))
    } catch {
      setError('Unable to load sticky note. Please retry.')
    } finally {
      setLoading(false)
    }
  }, [createNote])

  const save = useCallback(async (): Promise<boolean> => {
    if (pending.current) return pending.current
    if (deletingRef.current || !latest.current) return true
    if (JSON.stringify(latest.current) === saved.current) return true
    const task = (async () => {
      while (!deletingRef.current && latest.current && JSON.stringify(latest.current) !== saved.current) {
        const snapshot = latest.current
        const snapshotJson = JSON.stringify(snapshot)
        if (snapshot.content.length > 50000) {
          setStatus('Not saved')
          setError('This note is too long. Please shorten it before saving.')
          return false
        }
        setStatus('Saving...')
        try {
          const { data } = await api.put<Note>(`/sticky-notes/${snapshot.id}`, { ...snapshot, version: version.current })
          version.current = data.version
          const savedSnapshot = { ...snapshot, version: data.version, updated_at: data.updated_at }
          if (latest.current && JSON.stringify(latest.current) !== snapshotJson) {
            latest.current = { ...latest.current, version: data.version }
          } else {
            latest.current = savedSnapshot
            saved.current = JSON.stringify(savedSnapshot)
            setNote(savedSnapshot)
          }
          setError('')
        } catch (failure) {
          setStatus('Not saved')
          setError(errorMessage(failure))
          return false
        }
      }
      setStatus('All changes saved')
      return true
    })()
    pending.current = task
    try { return await task } finally { pending.current = null }
  }, [])

  useEffect(() => {
    if (!open || note) return
    void load()
  }, [open, note, load])

  useEffect(() => {
    if (editor.current && note) editor.current.innerHTML = cleanHTML(note.content)
  }, [note?.id])

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (colorMenuOpen || sizeMenuOpen || textColorOpen || highlightOpen) {
        setColorMenuOpen(false); setSizeMenuOpen(false); setTextColorOpen(false); setHighlightOpen(false)
        return
      }
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [open, colorMenuOpen, sizeMenuOpen, textColorOpen, highlightOpen])

  useEffect(() => {
    if (!colorMenuOpen && !sizeMenuOpen && !textColorOpen && !highlightOpen) return
    const dismiss = (event: MouseEvent) => {
      if (!(event.target as Element)?.closest?.('.sn-popover-wrap')) {
        setColorMenuOpen(false); setSizeMenuOpen(false); setTextColorOpen(false); setHighlightOpen(false)
      }
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [colorMenuOpen, sizeMenuOpen, textColorOpen, highlightOpen])

  useEffect(() => {
    const timer = window.setTimeout(() => { void save() }, 650)
    return () => window.clearTimeout(timer)
  }, [note, save])

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (latest.current && JSON.stringify(latest.current) !== saved.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])

  const change = (patch: Partial<Note>) => {
    if (!latest.current || deletingRef.current) return
    const next = { ...latest.current, ...patch }
    latest.current = next
    setNote(next)
    setStatus('Unsaved changes')
    setError('')
  }

  const format = (command: string) => {
    editor.current?.focus()
    document.execCommand(command, false)
    if (editor.current) change({ content: cleanHTML(editor.current.innerHTML) })
  }

  const applyInlineStyle = (property: 'color' | 'backgroundColor' | 'fontSize', value: string) => {
    const editorEl = editor.current
    if (!editorEl) return
    editorEl.focus()
    const selection = window.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    if (!range || range.collapsed || !editorEl.contains(range.commonAncestorContainer)) return
    const span = document.createElement('span')
    span.style[property] = value
    span.appendChild(range.extractContents())
    range.insertNode(span)
    selection?.removeAllRanges()
    const after = document.createRange()
    after.setStartAfter(span)
    after.collapse(true)
    selection?.addRange(after)
    change({ content: cleanHTML(editorEl.innerHTML) })
  }

  const setReminder = () => {
    const date = new Date(reminderDraft)
    if (!reminderDraft || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || date.getFullYear() > 2100) {
      setError('Choose a future reminder time.')
      return
    }
    change({ reminder_at: date.toISOString(), reminder_sent: false })
    setReminderOpen(false)
  }

  const remove = async () => {
    if (!latest.current) return
    deletingRef.current = true
    setDeleting(true)
    if (pending.current) await pending.current
    try {
      await api.delete(`/sticky-notes/${latest.current.id}`)
      const next = await createNote()
      latest.current = next
      saved.current = JSON.stringify(next)
      version.current = next.version
      setNote(next)
      setReminderDraft('')
      setDeleteOpen(false)
      if (editor.current) editor.current.innerHTML = ''
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  const openPanel = () => {
    if (!open) onOpen()
    setOpen(value => !value)
  }

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return
    const panelEl = panel.current
    if (!panelEl || event.button !== 0) return
    const rect = panelEl.getBoundingClientRect()
    drag.current = { startX: event.clientX, startY: event.clientY, startLeft: rect.left, startTop: rect.top }
    panelEl.style.left = `${rect.left}px`
    panelEl.style.top = `${rect.top}px`
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onDrag = (event: React.PointerEvent<HTMLElement>) => {
    const panelEl = panel.current
    if (!drag.current || !panelEl) return
    const { startX, startY, startLeft, startTop } = drag.current
    const maxLeft = window.innerWidth - 48
    const maxTop = window.innerHeight - 40
    const nextLeft = Math.min(Math.max(startLeft + (event.clientX - startX), 8 - panelEl.offsetWidth + 48), maxLeft)
    const nextTop = Math.min(Math.max(startTop + (event.clientY - startY), 0), maxTop)
    panelEl.style.left = `${nextLeft}px`
    panelEl.style.top = `${nextTop}px`
  }

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return <>
    <button ref={trigger} className={`sn-header-button ${open ? 'sn-header-active' : ''}`} title="Sticky notes" aria-label="Sticky notes" aria-expanded={open} aria-controls="sticky-notes-panel" onClick={openPanel}>
      <PinnedNoteIcon size={18} />
    </button>
    <div ref={panel} id="sticky-notes-panel" hidden={!open} tabIndex={-1} className={`sn-panel note-${note?.color || 'olive'}`} role="region" aria-label="Sticky notes">
      {loading ? <div className="sn-loading"><Loader2 className="animate-spin" size={20} /> Loading...</div>
        : !note ? <div className="sn-loading">{error || 'Unable to load sticky note.'}<button className="sn-error-retry" onClick={() => void load()}>Retry</button></div> : <>
        <header className="sn-topbar" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <div className="sn-popover-wrap">
            <button className={`sn-swatch-toggle ${colorMenuOpen ? 'sn-selected' : ''}`} title="Note color" aria-label="Note color" aria-expanded={colorMenuOpen}
              onClick={() => { setColorMenuOpen(!colorMenuOpen); setSizeMenuOpen(false); setTextColorOpen(false); setHighlightOpen(false) }}>
              <span className={`sn-swatch-dot note-${note.color}`} /><ChevronDown size={12} />
            </button>
            {colorMenuOpen && <div className="sn-popover sn-colors-popover" role="menu" aria-label="Note color">
              {colors.map(color => <button key={color} role="menuitem" title={`${color} note`} aria-label={`${color} note`} aria-pressed={note.color === color} className={`sn-swatch note-${color}`} onClick={() => { change({ color }); setColorMenuOpen(false) }}>{note.color === color && <Check size={13} />}</button>)}
            </div>}
          </div>
          <div className="sn-topbar-icons">
            <button className={`sn-icon ${note.reminder_at ? 'sn-selected' : ''}`} title="Reminder" aria-label="Reminder" aria-expanded={reminderOpen} onClick={() => setReminderOpen(!reminderOpen)}><AlarmClock size={13} /></button>
            <button className="sn-icon" title="Delete note" aria-label="Delete note" onClick={() => setDeleteOpen(true)}><Trash2 size={13} /></button>
            <button className="sn-icon" title="Minimize notes" aria-label="Minimize notes" onClick={() => { setOpen(false); trigger.current?.focus() }}><Minus size={14} /></button>
          </div>
        </header>

        <div className="sn-toolbar" role="toolbar" aria-label="Text formatting">
          <div className="sn-popover-wrap">
            <button className={`sn-format ${sizeMenuOpen ? 'sn-selected' : ''}`} aria-label="Font size" title="Font size" aria-expanded={sizeMenuOpen}
              onMouseDown={event => event.preventDefault()}
              onClick={() => { setSizeMenuOpen(!sizeMenuOpen); setTextColorOpen(false); setHighlightOpen(false) }}><Type size={14} /><ChevronDown size={10} /></button>
            {sizeMenuOpen && <div className="sn-popover sn-size-menu" role="menu">
              {FONT_SIZES.map(size => <button key={size.value} role="menuitem" style={{ fontSize: size.value }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => { applyInlineStyle('fontSize', size.value); setSizeMenuOpen(false) }}>{size.label}</button>)}
            </div>}
          </div>
          {([{ command: 'bold', label: 'Bold', Icon: Bold }, { command: 'italic', label: 'Italic', Icon: Italic },
            { command: 'underline', label: 'Underline', Icon: Underline }, { command: 'strikeThrough', label: 'Strikethrough', Icon: Strikethrough }]).map(({ command, label, Icon }) =>
            <button key={command} className="sn-format" aria-label={label} title={label} disabled={!document.queryCommandSupported(command)} onMouseDown={event => event.preventDefault()} onClick={() => format(command)}><Icon size={14} /></button>)}
          <div className="sn-popover-wrap">
            <button className={`sn-format ${textColorOpen ? 'sn-selected' : ''}`} aria-label="Text color" title="Text color" aria-expanded={textColorOpen}
              onMouseDown={event => event.preventDefault()}
              onClick={() => { setTextColorOpen(!textColorOpen); setSizeMenuOpen(false); setHighlightOpen(false) }}><Baseline size={14} /></button>
            {textColorOpen && <div className="sn-popover sn-color-grid" role="menu">
              {TEXT_COLORS.map(color => <button key={color} role="menuitem" aria-label={`Text color ${color}`} style={{ background: color }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => { applyInlineStyle('color', color); setTextColorOpen(false) }} />)}
            </div>}
          </div>
          <div className="sn-popover-wrap">
            <button className={`sn-format ${highlightOpen ? 'sn-selected' : ''}`} aria-label="Highlight color" title="Highlight color" aria-expanded={highlightOpen}
              onMouseDown={event => event.preventDefault()}
              onClick={() => { setHighlightOpen(!highlightOpen); setSizeMenuOpen(false); setTextColorOpen(false) }}><Highlighter size={14} /></button>
            {highlightOpen && <div className="sn-popover sn-color-grid" role="menu">
              {HIGHLIGHT_COLORS.map(color => <button key={color} role="menuitem" aria-label={`Highlight color ${color}`} style={{ background: color }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => { applyInlineStyle('backgroundColor', color); setHighlightOpen(false) }} />)}
            </div>}
          </div>
          {([{ command: 'insertUnorderedList', label: 'Bullet list', Icon: List },
            { command: 'insertOrderedList', label: 'Numbered list', Icon: ListOrdered }]).map(({ command, label, Icon }) =>
            <button key={command} className="sn-format" aria-label={label} title={label} disabled={!document.queryCommandSupported(command)} onMouseDown={event => event.preventDefault()} onClick={() => format(command)}><Icon size={14} /></button>)}
        </div>

        {reminderOpen && <form className="sn-reminder" onSubmit={event => { event.preventDefault(); setReminder() }}>
          <input aria-label="Reminder date and time" type="datetime-local" required value={reminderDraft} onChange={event => setReminderDraft(event.target.value)} />
          <button type="submit">Set</button>
          {note.reminder_at && <button type="button" onClick={() => { change({ reminder_at: null, reminder_sent: false }); setReminderDraft(''); setReminderOpen(false) }}>Remove</button>}
        </form>}

        <div ref={editor} contentEditable={!deleting} suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Note content" data-placeholder="Capture an idea, a follow-up, or something to remember..." className="sn-content sn-content-no-title"
          onInput={event => change({ content: cleanHTML(event.currentTarget.innerHTML) })}
          onPaste={event => { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')); if (editor.current) change({ content: cleanHTML(editor.current.innerHTML) }) }}
          onDrop={event => event.preventDefault()} onBlur={() => { if (!deleting) void save() }} />

        {deleteOpen && <div className="sn-delete-confirm" role="alert">
          <span>Delete this note?</span>
          <button disabled={deleting} onClick={() => void remove()}>{deleting ? 'Deleting...' : 'Delete'}</button>
          <button disabled={deleting} onClick={() => setDeleteOpen(false)}>Cancel</button>
        </div>}
        {error && <div className="sn-error" role="alert">{error}<button onClick={() => void save()}>Retry</button><button aria-label="Dismiss error" onClick={() => setError('')}><X size={13} /></button></div>}
      </>}
    </div>
  </>
}
