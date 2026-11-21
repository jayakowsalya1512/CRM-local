// Prototype v17 footer tab('recent','clock','Recent') — "Recently opened" panel.
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, X } from 'lucide-react'
import { useRecentItemsStore } from '@/store/recentItemsStore'
import { useFooterPanelStore } from '@/store/footerPanelStore'

const fmt = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function RecentFooterButton() {
  const navigate = useNavigate()
  const { items, clear, refresh } = useRecentItemsStore()
  const open = useFooterPanelStore((s) => s.panel === 'recent')
  const toggle = useFooterPanelStore((s) => s.toggle)
  const closePanel = useFooterPanelStore((s) => s.close)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    refresh()
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closePanel() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePanel() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refresh])

  return <div ref={ref} style={{ display: 'contents' }}>
    <button type="button" className={`tn-ftb ${open ? 'on' : ''}`} onClick={() => toggle('recent')} aria-expanded={open} aria-haspopup="dialog">
      <Clock size={15} /><span>Recent</span>
    </button>
    {open && <div className="tn-ftpn" role="dialog" aria-label="Recently opened">
      <div className="tn-fth">
        <Clock size={15} /><b>Recently opened</b><span className="flex-1" />
        {items.length > 0 && <button type="button" className="tn-link" onClick={clear}>Clear</button>}
        <button type="button" className="tn-x" onClick={closePanel} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="tn-ftb3">
        {items.length ? items.map((item) => (
          <button type="button" key={item.path} className="tn-annc" onClick={() => { closePanel(); navigate(item.path) }}>
            <div className="flex items-center gap-1.5">
              <span className="tn-pill inf">{item.module}</span>
              <small>{fmt(item.at)}</small>
            </div>
            <b>{item.label}</b>
          </button>
        )) : <div className="tn-empty">Records you open appear here</div>}
      </div>
    </div>}
  </div>
}
