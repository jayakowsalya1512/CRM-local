import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import Button from './Button'

interface SlidePanelProps {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  tabBar?: React.ReactNode
  width?: string
  side?: 'right' | 'left'
  insetLeft?: string
  insetTop?: string
  bodyClassName?: string
  headerClassName?: string
}

export default function SlidePanel({
  open, onClose, title, subtitle, children, footer, tabBar,
  width = 'w-[640px]', side = 'right', insetLeft, insetTop, bodyClassName = '',
  headerClassName,
}: SlidePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const shouldApplyInsetLeft = Boolean(insetLeft)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
      document.body.dataset.slidePanelOpen = 'true'
    } else {
      document.body.style.overflow = ''
      delete document.body.dataset.slidePanelOpen
    }
    return () => {
      document.body.style.overflow = ''
      delete document.body.dataset.slidePanelOpen
    }
  }, [open])

  if (!open) return null

  const shellStyle = {
    ...(shouldApplyInsetLeft ? { left: insetLeft } : {}),
    ...(insetTop ? { top: insetTop } : {}),
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100120] flex"
      style={shellStyle}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className={`
          absolute ${side === 'right' ? 'right-0' : 'left-0'} top-0 h-full min-h-0 overflow-hidden
          ${shouldApplyInsetLeft ? 'w-full' : width} max-w-full bg-white shadow-2xl flex flex-col
          transform transition-transform duration-300 ease-out
          ${open ? 'translate-x-0' : side === 'right' ? 'translate-x-full' : '-translate-x-full'}
        `}
      >
        {/* Header */}
        <div className={`flex items-start justify-between px-6 py-4 border-b flex-shrink-0 ${headerClassName ?? 'bg-gray-50 border-gray-100'}`}>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            {subtitle && <div className="text-sm text-gray-500 mt-1">{subtitle}</div>}
          </div>
          <button
            onClick={onClose}
            className="ml-3 mt-0.5 p-1 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Tab Bar — fixed between header and body */}
        {tabBar && (
          <div className="flex-shrink-0 border-b border-gray-200 bg-white px-6">
            {tabBar}
          </div>
        )}

        {/* Scrollable Body */}
        <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-5 flex flex-col ${bodyClassName}`}>
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex-shrink-0 px-6 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

/* Mini panel — slides from LEFT, for adding masters mid-form */
export function MiniPanel({
  open, onClose, title, children,
}: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    if (open) document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[100120] flex">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute left-0 top-0 h-full min-h-0 w-[420px] max-w-full overflow-hidden bg-white shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-blue-50 flex-shrink-0">
          <h3 className="text-base font-semibold text-blue-900">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg text-blue-400 hover:text-blue-700 hover:bg-blue-100">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body
  )
}

