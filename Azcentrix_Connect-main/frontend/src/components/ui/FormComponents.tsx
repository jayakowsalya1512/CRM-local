// ── StatusBadge ───────────────────────────────────────────────────────────────
import { createPortal } from 'react-dom'

export { ToastProvider, useToast } from './ToastContext'

const STATUS_COLORS: Record<string, string> = {
  // Lead
  New: 'bg-slate-100 text-slate-700',
  Assigned: 'bg-blue-100 text-blue-700',
  'Qualified': 'bg-yellow-100 text-yellow-700',
  'Opportunity Created': 'bg-purple-100 text-purple-700',
  Converted: 'bg-green-100 text-green-700',
  Lost: 'bg-red-100 text-red-700',
  // Tender
  Aligned: 'bg-blue-100 text-blue-700',
  Evaluation: 'bg-amber-100 text-amber-700',
  'Pre-Bid': 'bg-orange-100 text-orange-700',
  'Reverse Auction': 'bg-pink-100 text-pink-700',
  Submitted: 'bg-indigo-100 text-indigo-700',
  Closed: 'bg-gray-100 text-gray-600',
  Won: 'bg-green-100 text-green-700',
  Pending: 'bg-yellow-100 text-yellow-700',
  // Work Order
  Draft: 'bg-gray-100 text-gray-600',
  Confirmed: 'bg-blue-100 text-blue-700',
  'In Progress': 'bg-indigo-100 text-indigo-700',
  'On Hold': 'bg-orange-100 text-orange-700',
  Delayed: 'bg-red-100 text-red-700',
  Completed: 'bg-green-100 text-green-700',
  Cancelled: 'bg-red-100 text-red-700',
  // Finance
  Active: 'bg-green-100 text-green-700',
  Expired: 'bg-red-100 text-red-700',
  Released: 'bg-gray-100 text-gray-600',
  Renewed: 'bg-blue-100 text-blue-700',
  // Travel / TADA
  Approved: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
  'Manager Approved': 'bg-teal-100 text-teal-700',
  'Accounts Approved': 'bg-cyan-100 text-cyan-700',
  Paid: 'bg-green-100 text-green-700',
  // Priority
  High: 'bg-red-100 text-red-700',
  Medium: 'bg-yellow-100 text-yellow-700',
  Low: 'bg-green-100 text-green-700',
  // Approval
  pending: 'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
  none: 'bg-gray-100 text-gray-500',
  // Critical / Warning
  Critical: 'bg-red-100 text-red-700',
  Warning: 'bg-amber-100 text-amber-700',
  OK: 'bg-green-100 text-green-700',
}

interface StatusBadgeProps {
  status: string
  size?: 'sm' | 'md'
}

export function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const color = STATUS_COLORS[status] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center rounded-full font-medium whitespace-nowrap
      ${color} ${size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-xs px-2.5 py-1'}`}>
      {status}
    </span>
  )
}

// ── FormSection ───────────────────────────────────────────────────────────────
interface FormSectionProps {
  title: string
  subtitle?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function FormSection({ title, subtitle, action, children, className = '' }: FormSectionProps) {
  return (
    <div className={`mb-3 ${className}`}>
      <div className="flex items-center justify-between mb-1.5">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="bg-gray-50/50 rounded-xl border border-gray-100 p-3">
        {children}
      </div>
    </div>
  )
}

// ── FormGrid ──────────────────────────────────────────────────────────────────
export function FormGrid({ cols = 2, children }: { cols?: 1 | 2 | 3 | 4; children: React.ReactNode }) {
  const gridCols = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }
  return <div className={`grid ${gridCols[cols]} gap-x-3 gap-y-2.5`}>{children}</div>
}

// ── DatePicker ────────────────────────────────────────────────────────────────
import { FormField } from './Input'
import { useThemeStore } from '@/store'

interface DatePickerProps {
  label?: string
  value?: string
  onChange: (v: string) => void
  required?: boolean
  disabled?: boolean
  error?: string
  hint?: string
  min?: string
  max?: string
}

export function DatePicker({ label, value, onChange, required, disabled, error, hint, min, max }: DatePickerProps) {
  const dateFormat = useThemeStore((state) => state.theme.date_format || 'DD-MM-YYYY')
  const inputLang = dateFormat === 'MM-DD-YYYY'
    ? 'en-US'
    : dateFormat === 'YYYY-MM-DD'
      ? 'sv-SE'
      : 'en-GB'

  return (
    <FormField label={label} required={required} error={error} hint={hint}>
      <input
        type="date"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        min={min}
        max={max}
        lang={inputLang}
        title={`Date format: ${dateFormat}`}
        className={`form-control ${error ? 'error' : ''}`}
      />
    </FormField>
  )
}

// ── Toaster ───────────────────────────────────────────────────────────────────

// ── ConfirmDialog ─────────────────────────────────────────────────────────────
import Button from './Button'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'danger' | 'warning' | 'primary'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'danger', onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[100120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 z-10">
        <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
        <p className="text-sm text-gray-600 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <Button variant="cancel" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={variant === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── EmptyState ────────────────────────────────────────────────────────────────
interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
  action?: React.ReactNode
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {icon && <div className="mb-4 p-4 bg-gray-100 rounded-2xl text-gray-400">{icon}</div>}
      <h3 className="text-base font-semibold text-gray-800 mb-1">{title}</h3>
      {description && <p className="text-sm text-gray-500 max-w-xs mb-4">{description}</p>}
      {action}
    </div>
  )
}

// ── PageHeader ────────────────────────────────────────────────────────────────
interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  breadcrumb?: string[]
  children?: React.ReactNode
}

export function PageHeader({ title, subtitle, actions, breadcrumb, children }: PageHeaderProps) {
  return (
    <div className="mb-6">
      {breadcrumb && (
        <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-2">
          {breadcrumb.map((b, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span>/</span>}
              <span className={i === breadcrumb.length - 1 ? 'text-gray-600 font-medium' : ''}>{b}</span>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-4">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-3 flex-shrink-0">{actions}</div>}
      </div>
      {children && <div className="mt-8">{children}</div>}
    </div>
  )
}

// ── StatCard ──────────────────────────────────────────────────────────────────
interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  icon?: React.ReactNode
  trend?: { value: number; label: string }
  color?: 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'indigo' | 'gray'
  onClick?: () => void
  active?: boolean
}

const STAT_COLORS = {
  blue:   { bg: 'bg-blue-50',   icon: 'bg-blue-100 text-blue-600',     text: 'text-blue-600'   },
  green:  { bg: 'bg-green-50',  icon: 'bg-green-100 text-green-600',   text: 'text-green-600'  },
  amber:  { bg: 'bg-amber-50',  icon: 'bg-amber-100 text-amber-600',   text: 'text-amber-600'  },
  red:    { bg: 'bg-red-50',    icon: 'bg-red-100 text-red-600',       text: 'text-red-600'    },
  purple: { bg: 'bg-purple-50', icon: 'bg-purple-100 text-purple-600', text: 'text-purple-600' },
  indigo: { bg: 'bg-indigo-50', icon: 'bg-indigo-100 text-indigo-600', text: 'text-indigo-600' },
  gray:   { bg: 'bg-slate-50',  icon: 'bg-slate-100 text-slate-600',   text: 'text-slate-600'  },
}

export function StatCard({ title, value, subtitle, icon, trend, color = 'blue', onClick, active }: StatCardProps) {
  const c = STAT_COLORS[color]
  return (
    <div
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onClick()
        }
      }}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`
        bg-white rounded-2xl border p-5 shadow-sm
        ${active ? 'border-blue-300 ring-2 ring-blue-100' : 'border-gray-100'}
        ${onClick ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 transition-all' : ''}
      `}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 whitespace-nowrap">{title}</p>
          <p className="text-3xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className={`text-xl font-bold mt-1.5 ${c.text}`}>{subtitle}</p>}
          {trend && (
            <p className={`text-xs mt-2 font-medium ${trend.value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)}% {trend.label}
            </p>
          )}
        </div>
        {icon && (
          <div className={`p-3 rounded-xl ${c.icon}`}>{icon}</div>
        )}
      </div>
    </div>
  )
}

// ── useFieldErrors ────────────────────────────────────────────────────────────
import { useState } from 'react'

export function useFieldErrors() {
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const clearFieldError = (key: string) =>
    setFieldErrors(prev => { const n = { ...prev }; delete n[key]; return n })

  // Returns the error prop value: space string triggers red border without showing text
  const errProp = (key: string): string | undefined =>
    fieldErrors[key] ? ' ' : undefined

  return { fieldErrors, setFieldErrors, clearFieldError, errProp }
}

// ── FormCard ──────────────────────────────────────────────────────────────────
interface FormCardProps {
  id: string
  title: string
  icon: React.ElementType
  children: React.ReactNode
  action?: React.ReactNode
}

export function FormCard({ id, title, icon: Icon, children, action }: FormCardProps) {
  return (
    <div id={`section-${id}`} className="rounded-xl border border-slate-200 shadow-sm overflow-hidden mb-3 last:mb-0">
      <div className="flex items-center justify-between px-6 py-2 bg-slate-50/60 border-b border-slate-100">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center">
            <Icon size={14} className="text-indigo-600" />
          </div>
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
        </div>
        {action && <div>{action}</div>}
      </div>
      <div className="px-4 py-2">{children}</div>
    </div>
  )
}
