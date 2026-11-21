import React, { forwardRef, useState } from 'react'
import { ChevronDown, Eye, EyeOff } from 'lucide-react'
import { SelectOption } from '@/types'

// ── FormLabel ─────────────────────────────────────────────────────────────────
interface FormLabelProps {
  children: React.ReactNode
  required?: boolean
  htmlFor?: string
  className?: string
}

export function FormLabel({ children, required, htmlFor, className = '' }: FormLabelProps) {
  return (
    <label htmlFor={htmlFor} className={`form-label ${className}`} data-required={required || undefined}>
      <span className="form-label-text">{children}</span>
      {required && <span className="form-required-mark required text-red-500" aria-hidden="true">*</span>}
    </label>
  )
}

interface FormFieldProps {
  label?: React.ReactNode
  labelAction?: React.ReactNode
  required?: boolean
  htmlFor?: string
  error?: string
  hint?: string
  className?: string
  children: React.ReactNode
}

export const FormField = forwardRef<HTMLDivElement, FormFieldProps>(({
  label,
  labelAction,
  required,
  htmlFor,
  error,
  hint,
  className = '',
  children,
}, ref) => {
  return (
    <div ref={ref} className={`form-group ${className}`}>
      {(label || labelAction) && (
        <div className="form-label-row">
          {label && <FormLabel required={required} htmlFor={htmlFor}>{label}</FormLabel>}
          {labelAction && <div className="form-label-action">{labelAction}</div>}
        </div>
      )}
      {children}
      {error && error.trim() && <p className="form-error">{error}</p>}
      {hint && !error && <p className="form-hint">{hint}</p>}
    </div>
  )
})
FormField.displayName = 'FormField'

// ── Numeric-only key handler (exported for use on raw <input> elements) ────────
export function numericKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
  const allowed = ['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter']
  if (allowed.includes(e.key)) return
  if (e.ctrlKey || e.metaKey) return
  if (e.key === '.') {
    if (e.currentTarget.value.includes('.')) e.preventDefault()
    return
  }
  if (!/^\d$/.test(e.key)) e.preventDefault()
}

function toIndianCommas(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return ''
  return Number(digits).toLocaleString('en-IN')
}

// ── Input ─────────────────────────────────────────────────────────────────────
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  required?: boolean
  icon?: React.ReactNode
  iconRight?: React.ReactNode
  numberOnly?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({
  label, error, hint, required, icon, iconRight, className = '', numberOnly, ...props
}, ref) => {
  const { onKeyDown, onChange, type, value, ...restProps } = props
  const [showPassword, setShowPassword] = useState(false)
  // Local formatted display state for numberOnly inputs
  const [display, setDisplay] = useState(() =>
    numberOnly && value !== undefined ? toIndianCommas(String(value ?? '')) : ''
  )

  // Sync display when external value changes (e.g. form reset or edit load)
  const prevValue = React.useRef(value)
  if (prevValue.current !== value) {
    prevValue.current = value
    if (numberOnly) {
      const formatted = toIndianCommas(String(value ?? ''))
      if (formatted !== display) setDisplay(formatted)
    }
  }

  const isPasswordField = type === 'password'
  const resolvedType = isPasswordField && showPassword ? 'text' : type
  const hasTrailingControl = isPasswordField || Boolean(iconRight)

  const handleKeyDown = numberOnly
    ? (e: React.KeyboardEvent<HTMLInputElement>) => { numericKeyDown(e); onKeyDown?.(e) }
    : onKeyDown

  const handleChange = numberOnly
    ? (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value.replace(/,/g, '')
        const formatted = toIndianCommas(raw)
        setDisplay(formatted)
        if (onChange) {
          // fire onChange with raw digits in target.value
          ;(e.target as HTMLInputElement & { value: string }).value = raw
          ;(onChange as React.ChangeEventHandler<HTMLInputElement>)(e)
        }
      }
    : onChange as React.ChangeEventHandler<HTMLInputElement> | undefined

  return (
    <FormField label={label} required={required} htmlFor={restProps.id} error={error} hint={hint}>
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
            {icon}
          </span>
        )}
        <input
          ref={ref}
          className={`form-control ${error ? 'error' : ''} ${icon ? 'pl-9' : ''} ${hasTrailingControl ? 'pr-10' : ''} ${className}`}
          onKeyDown={handleKeyDown}
          onChange={handleChange}
          type={numberOnly ? 'text' : resolvedType}
          value={numberOnly ? display : value}
          {...restProps}
        />
        {isPasswordField ? (
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            disabled={props.disabled}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: showPassword ? '#2563eb' : 'var(--text-muted)' }}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        ) : iconRight && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }}>
            {iconRight}
          </span>
        )}
      </div>
    </FormField>
  )
})
Input.displayName = 'Input'

// ── Select ────────────────────────────────────────────────────────────────────
interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  hint?: string
  required?: boolean
  options: SelectOption[]
  placeholder?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(({
  label, error, hint, required, options, placeholder, className = '', ...props
}, ref) => {
  return (
    <FormField label={label} required={required} htmlFor={props.id} error={error} hint={hint}>
      <div className="relative">
        <select
          ref={ref}
          className={`form-control form-select pr-9 ${error ? 'error' : ''} ${className}`}
          {...props}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: 'var(--text-muted)' }} />
      </div>
    </FormField>
  )
})
Select.displayName = 'Select'

// ── Textarea ──────────────────────────────────────────────────────────────────
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  error?: string
  hint?: string
  required?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({
  label, error, hint, required, className = '', ...props
}, ref) => {
  return (
    <FormField label={label} required={required} htmlFor={props.id} error={error} hint={hint}>
      <textarea
        ref={ref}
        className={`form-control ${error ? 'error' : ''} ${className}`}
        {...props}
      />
    </FormField>
  )
})
Textarea.displayName = 'Textarea'

// ── Checkbox ──────────────────────────────────────────────────────────────────
interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string
}

export function Checkbox({ label, className = '', ...props }: CheckboxProps) {
  return (
    <label className={`flex items-center gap-2 cursor-pointer text-sm ${className}`}
      style={{ color: 'var(--text-primary)' }}>
      <input type="checkbox" className="w-4 h-4 rounded accent-current" {...props} />
      {label}
    </label>
  )
}

// ── SearchInput ────────────────────────────────────────────────────────────────
interface SearchInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}

export function SearchInput({ value, onChange, placeholder = 'Search...', className = '' }: SearchInputProps) {
  return (
    <div className={`relative ${className}`}>
      <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" fill="none" viewBox="0 0 24 24"
        stroke="currentColor" style={{ color: 'var(--text-muted)' }}>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <input
        className="form-control pl-9 pr-4"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          onClick={() => onChange('')}
        >×</button>
      )}
    </div>
  )
}

// ── FormGrid ──────────────────────────────────────────────────────────────────
export function FormGrid({ children, cols = 2 }: { children: React.ReactNode; cols?: 1 | 2 | 3 }) {
  const gridClass = cols === 1 ? 'grid-cols-1' : cols === 3 ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1 md:grid-cols-2'
  return <div className={`grid ${gridClass} gap-4`}>{children}</div>
}

export function FormSection({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`mb-6 ${className}`}>
      <h4 className="text-xs font-semibold uppercase tracking-wider mb-3 pb-2"
        style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
        {title}
      </h4>
      {children}
    </div>
  )
}

export default Input
