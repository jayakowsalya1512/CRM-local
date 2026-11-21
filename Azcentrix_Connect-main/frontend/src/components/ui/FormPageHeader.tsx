import { ChevronRight } from 'lucide-react'
import { Button } from './Button'
import type { ReactNode } from 'react'

interface FormPageHeaderProps {
  breadcrumb: string
  onBreadcrumbClick: () => void
  title: string
  isEdit?: boolean
  onCancel: () => void
  onSave: () => void
  saving?: boolean
  saveLabel?: string
  currentLabel?: string
  actions?: ReactNode
  showEditBadge?: boolean
}

export default function FormPageHeader({
  breadcrumb,
  onBreadcrumbClick,
  title,
  isEdit = false,
  onCancel,
  onSave,
  saving = false,
  saveLabel,
  currentLabel,
  actions,
  showEditBadge = true,
}: FormPageHeaderProps) {
  const label = saveLabel ?? (isEdit ? `Update ${title}` : `Save ${title}`)
  const headerLabel = currentLabel ?? (isEdit ? `Edit ${title}` : `New ${title}`)

  return (
    <div className="form-page-header sticky top-0 z-20 bg-white border-b border-slate-100">
      <div className="flex items-center justify-between px-6 py-3">

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBreadcrumbClick}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 transition-colors"
          >
            <span>{breadcrumb}</span>
            <ChevronRight size={12} className="text-slate-300" />
          </button>
          <span className="text-sm font-semibold text-slate-800">
            {headerLabel}
          </span>
          {isEdit && showEditBadge && (
            <span className="text-xs bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded-full font-medium">
              Editing
            </span>
          )}
        </div>

        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <Button size="sm" loading={saving} onClick={onSave}>
              {label}
            </Button>
          </div>
        )}

      </div>
    </div>
  )
}
