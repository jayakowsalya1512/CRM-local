import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, Maximize2, Minimize2, Minus } from 'lucide-react'
import { Ic } from '@/components/crm/kit'
import { buildFilePreviewUrl } from './questionnaireFormShared'
import '@/pages/notifications/inbox.css'

interface Props {
  fileUrl: string
  fileName?: string
  onClose: () => void
  allowDownload?: boolean
  infoBanner?: React.ReactNode
}

type ViewMode = 'normal' | 'maximized' | 'minimized'

export default function FilePreviewModal({ fileUrl, fileName, onClose, allowDownload = true, infoBanner }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('normal')
  const name = fileName || fileUrl.split('/').pop() || 'Document'

  const previewUrl = buildFilePreviewUrl(fileUrl, '/preview/file')
  const downloadUrl = buildFilePreviewUrl(fileUrl, '/preview/download')
  const canLoadPreview = Boolean(previewUrl)

  const host = document.querySelector('.crm-shell') ?? document.body

  if (viewMode === 'minimized') {
    return createPortal(
      <div
        className="bwi"
        style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 9999, display: 'flex', width: 288, alignItems: 'center',
          gap: 10, borderRadius: 12, border: '1px solid var(--bw-ln)', background: 'var(--bw-sf)', padding: '10px 14px',
          boxShadow: 'var(--bw-sh2, 0 20px 50px rgba(15,23,42,.22))',
        }}
      >
        <Ic n="file" />
        <p className="mu" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--bw-tx)' }}>{name}</p>
        <button type="button" onClick={() => setViewMode('normal')} title="Restore" className="btn g s">
          <Maximize2 size={14} />
        </button>
        <button type="button" onClick={onClose} title="Close" className="btn g s">
          <Ic n="x" />
        </button>
      </div>,
      host
    )
  }

  const isMaximized = viewMode === 'maximized'

  return createPortal(
    <div className="bwi bwi-ov" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        className="md"
        role="dialog"
        aria-modal="true"
        style={{ width: isMaximized ? '96vw' : 'min(900px, 100%)', maxWidth: 'none', height: isMaximized ? '96vh' : '90vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ph">
          <span className="fl" style={{ display: 'flex', minWidth: 0, alignItems: 'center', gap: 10 }}>
            <Ic n="file" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
          </span>
          <div className="row" style={{ gap: 6, flex: 'none' }}>
            {allowDownload && (
              <a href={downloadUrl} download={name} className="btn g s">
                <Ic n="dl" /> Download
              </a>
            )}
            <a href={previewUrl} target="_blank" rel="noreferrer" className="btn g s">
              <ExternalLink size={13} /> Open tab
            </a>
            <button type="button" onClick={() => setViewMode('minimized')} title="Minimize" className="btn g s">
              <Minus size={14} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode(isMaximized ? 'normal' : 'maximized')}
              title={isMaximized ? 'Restore' : 'Maximize'}
              className="btn g s"
            >
              {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button type="button" onClick={onClose} title="Close" className="btn g s" aria-label="Close">
              <Ic n="x" />
            </button>
          </div>
        </div>
        {infoBanner && (
          <div className="note inf" style={{ borderRadius: 0, borderLeft: 'none', borderRight: 'none' }}>
            {infoBanner}
          </div>
        )}
        <div className="pb z" style={{ position: 'relative', flex: 1, overflow: 'hidden', padding: 0, background: 'var(--bw-hd)' }}>
          {canLoadPreview ? (
            <iframe key={previewUrl} src={previewUrl} style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title={name} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
              <span className="pill mu" style={{ height: 64, width: 64, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Ic n="file" />
              </span>
              <div>
                <p className="font-semibold" style={{ color: 'var(--bw-tx)', fontSize: 14 }}>{name}</p>
                <p className="mu mt" style={{ fontSize: 12 }}>Preview not available for this file type</p>
              </div>
              {allowDownload && (
                <a href={downloadUrl} download={name} className="btn p">
                  <Ic n="dl" /> Download file
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>,
    host
  )
}
