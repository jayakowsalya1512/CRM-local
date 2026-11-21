/**
 * ListDrilldownModal.tsx — generic "click a KPI card / chart segment, see the
 * matching rows" modal used across the Analytical Reports views. Keeps the
 * same rows/columns already defined for the page's main table so the
 * drilldown data always matches what's on screen.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, X } from 'lucide-react'
import { DataTable } from '@/components/ui/DataTable'
import type { ColDef } from '../../dashboard/tabs/_shared'

export interface ListDrilldownRequest {
  title: string
  sub?: string
  rows: any[]
  columns: ColDef[]
}

export function ListDrilldownModal({
  request,
  onClose,
  onRowClick,
}: {
  request: ListDrilldownRequest | null
  onClose: () => void
  onRowClick?: (row: any) => void
}) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (request) setMaximized(false)
  }, [request])

  if (!request) return null

  return createPortal(
    <div className="fixed inset-0 z-[9998] flex items-center justify-center overflow-hidden bg-slate-950/40 p-4 backdrop-blur-sm">
      <div
        className={`flex w-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all duration-300 ${
          maximized ? 'h-full' : 'h-[85vh] max-w-[1100px]'
        }`}
      >
        <div className="flex shrink-0 items-start justify-between border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold text-slate-900">
              {request.title}
            </div>
            {request.sub ? (
              <div className="mt-0.5 text-[11.5px] text-slate-500">
                {request.sub}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setMaximized(v => !v)}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              title={maximized ? 'Minimize' : 'Maximize'}
            >
              {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>

            <button
              onClick={onClose}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600"
              title="Close"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <DataTable
            data={request.rows}
            columns={request.columns as any}
            title={request.title}
            onRowClick={onRowClick}
            showExport
            showColumnToggle
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
