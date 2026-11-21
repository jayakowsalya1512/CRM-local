import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Ic } from '@/components/crm/kit'

// Prototype .ov / .md modal, portaled into .crm-shell so it keeps the theme tokens
// (and escapes main's entry animation, which would otherwise contain position: fixed).
export function Modal({ title, width = 560, onClose, foot, children }: { title: ReactNode; width?: number; onClose: () => void; foot?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  const host = document.querySelector('.crm-shell') ?? document.body
  return createPortal(
    <div className="bwi bwi-ov" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="md" role="dialog" aria-modal="true" style={{ width: `min(${width}px, 100%)` }}>
        <div className="ph"><span className="fl">{title}</span><button type="button" className="btn g s" onClick={onClose} aria-label="Close"><Ic n="x" /></button></div>
        <div className="pb">{children}</div>
        {foot && <div className="pf">{foot}</div>}
      </div>
    </div>, host)
}

