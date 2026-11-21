// Footer "Quick note" – prototype v17 ftPanel('note'): Quick note · textarea · Open Notes · Save note.
// Saves a yellow note to Notes & Pinboard (/api/v1/notes, same records as the page).
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Ic } from '@/components/crm/kit'
import { useToast } from '@/components/ui/ToastContext'
import { errMsg, notesApi } from '@/pages/notes/notesApi'
import RecordLinkPicker, { type RecordLink } from '@/components/notes/RecordLinkPicker'
import { useFooterPanelStore } from '@/store/footerPanelStore'
import '@/pages/notes/notes.css'

export default function QuickNote() {
  const navigate = useNavigate()
  const { success, error, warning } = useToast()
  const open = useFooterPanelStore((s) => s.panel === 'quicknote')
  const toggle = useFooterPanelStore((s) => s.toggle)
  const closePanel = useFooterPanelStore((s) => s.close)
  const [text, setText] = useState('')
  const [link, setLink] = useState<RecordLink | null>(null)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    ta.current?.focus()
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closePanel() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc) }
  }, [open, closePanel])

  const save = async () => {
    const t = text.trim()
    if (!t) { warning('Write a note first'); ta.current?.focus(); return }
    setBusy(true)
    try {
      const html = t.split('\n').map(line => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('<br>')
      await notesApi.create({ content: html, color: 'yellow', source: 'quick', link_module: link?.module, link_record_id: link?.id })
      setText(''); setLink(null); closePanel(); success('Saved to Notes & Pinboard')
    } catch (e) { error(errMsg(e, 'Could not save the note – your text is still here')) }
    finally { setBusy(false) }
  }

  return <span ref={ref} style={{ display: 'contents' }}>
    <button type="button" className={`tn-ftb ${open ? 'on' : ''}`} onClick={() => toggle('quicknote')} aria-expanded={open} aria-haspopup="dialog">
      <Ic n="note" /><span>Quick note</span>
    </button>
    {open && <div className="tn-ftpn tn-qn" role="dialog" aria-label="Quick note">
      <div className="tn-fth"><Ic n="note" /><b>Quick note</b><span className="flex-1" />
        <button type="button" className="tn-x" onClick={closePanel} aria-label="Close"><Ic n="x" /></button></div>
      <div className="tn-ftb3" style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <textarea ref={ta} rows={6} value={text} maxLength={20000} onChange={e => setText(e.target.value)} placeholder="Jot something down – saved to Notes & Pinboard"
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save() } }} />
        <RecordLinkPicker value={link} onChange={setLink} />
      </div>
      <div className="ftf">
        <button type="button" className="qbtn" onClick={() => { closePanel(); navigate('/notes') }}>Open Notes</button>
        <span className="flex-1" />
        <button type="button" className="qbtn p" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save note'}</button>
      </div>
    </div>}
  </span>
}
