import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Users, X } from 'lucide-react'

export interface WorkingGroupPickerOption {
  value: number
  label: string
  subtitle?: string
}

interface WorkingGroupPickerProps {
  options: WorkingGroupPickerOption[]
  value?: number | string | null
  onChange: (value: number | null) => void
  label?: string
  placeholder?: string
  required?: boolean
  disabled?: boolean
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  showTrigger?: boolean
}

export default function WorkingGroupPicker({
  options,
  value,
  onChange,
  label = 'Working Group',
  placeholder = 'Select working group',
  required,
  disabled,
  className = '',
  open,
  onOpenChange,
  showTrigger = true,
}: WorkingGroupPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const popupOpen = open ?? internalOpen
  const selected = useMemo(
    () => options.find(option => String(option.value) === String(value ?? '')),
    [options, value],
  )

  const setPopupOpen = (nextOpen: boolean) => {
    if (open === undefined) setInternalOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }

  useEffect(() => {
    if (!popupOpen) return undefined

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopupOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [popupOpen])

  const selectGroup = (nextValue: number) => {
    onChange(nextValue)
    setPopupOpen(false)
  }

  const popup = popupOpen ? (
    <div className="fixed inset-0 z-[100130] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/45 backdrop-blur-sm" onClick={() => setPopupOpen(false)} />
      <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900">Select Working Group</h3>
            <p className="text-xs text-gray-500 mt-0.5">Confirm the approval flow before submitting.</p>
          </div>
          <button
            type="button"
            onClick={() => setPopupOpen(false)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex-shrink-0"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="max-h-[360px] overflow-y-auto p-2">
          {options.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">No working groups available</div>
          ) : options.map(option => {
            const active = String(option.value) === String(value ?? '')
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => selectGroup(Number(option.value))}
                className={[
                  'w-full rounded-xl px-3 py-3 text-left transition-colors',
                  'flex items-start gap-3',
                  active ? 'bg-blue-50' : 'hover:bg-gray-50',
                ].join(' ')}
              >
                <span className={[
                  'mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border flex-shrink-0',
                  active ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300 text-transparent',
                ].join(' ')}>
                  <Check size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900">{option.label}</span>
                  <span className="block text-xs text-gray-500 mt-0.5">
                    {option.subtitle || 'Approval flow is not configured'}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  ) : null

  if (!showTrigger) return popup

  return (
    <div className={className}>
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setPopupOpen(true)}
        className={[
          'w-full min-h-[42px] px-3 py-2.5 rounded-lg border text-left transition-all bg-white',
          'flex items-center gap-3',
          disabled
            ? 'bg-gray-50 cursor-not-allowed text-gray-400 border-gray-200'
            : popupOpen
              ? 'border-blue-500 ring-2 ring-blue-100'
              : 'border-gray-300 hover:border-gray-400',
        ].join(' ')}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50 text-blue-600 flex-shrink-0">
          <Users size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className={`block text-sm font-medium truncate ${selected ? 'text-gray-900' : 'text-gray-400'}`}>
            {selected?.label || placeholder}
          </span>
          {selected?.subtitle && (
            <span className="block text-xs text-gray-500 truncate">{selected.subtitle}</span>
          )}
        </span>
        <ChevronDown size={14} className="text-gray-400 flex-shrink-0" />
      </button>

      {popup}
    </div>
  )
}
