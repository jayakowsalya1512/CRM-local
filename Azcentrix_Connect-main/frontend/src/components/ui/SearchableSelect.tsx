import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react'
import { FormField } from './Input'

export interface SelectOption {
  value: string | number
  label: string
  subtitle?: string
  subtitleClassName?: string
  disabled?: boolean
}

interface SearchableSelectProps {
  options: SelectOption[]
  value?: string | number | null
  onChange: (value: string | number | null) => void
  placeholder?: string
  label?: ReactNode
  labelAction?: ReactNode
  error?: string
  hint?: string
  required?: boolean
  disabled?: boolean
  loading?: boolean
  clearable?: boolean
  onAddNew?: () => void
  addNewLabel?: string
  className?: string
}

interface DropdownPosition {
  top: number
  left: number
  width: number
  maxHeight: number
  placement: 'top' | 'bottom'
}

const DROPDOWN_GAP = 4
const DROPDOWN_VIEWPORT_PADDING = 12
const DROPDOWN_MIN_HEIGHT = 180
const DROPDOWN_MAX_HEIGHT = 280
const DROPDOWN_SEARCH_HEIGHT = 64
const DROPDOWN_FOOTER_HEIGHT = 52

function getDropdownPosition(triggerRect: DOMRect, hasFooter: boolean, preferredPlacement: 'auto' | 'bottom' = 'auto'): DropdownPosition {
  const availableBelow = Math.max(
    0,
    window.innerHeight - triggerRect.bottom - DROPDOWN_VIEWPORT_PADDING - DROPDOWN_GAP,
  )
  const availableAbove = Math.max(
    0,
    triggerRect.top - DROPDOWN_VIEWPORT_PADDING - DROPDOWN_GAP,
  )

  const placement: 'top' | 'bottom' = preferredPlacement === 'bottom'
    ? 'bottom'
    : availableBelow < DROPDOWN_MIN_HEIGHT && availableAbove > availableBelow ? 'top' : 'bottom'

  const availableHeight = placement === 'bottom' ? availableBelow : availableAbove
  const panelHeight = Math.max(
    DROPDOWN_MIN_HEIGHT,
    Math.min(DROPDOWN_MAX_HEIGHT, availableHeight || DROPDOWN_MIN_HEIGHT),
  )
  const chromeHeight = DROPDOWN_SEARCH_HEIGHT + (hasFooter ? DROPDOWN_FOOTER_HEIGHT : 0)
  const maxHeight = Math.max(96, panelHeight - chromeHeight)
  const width = Math.min(
    triggerRect.width,
    window.innerWidth - (DROPDOWN_VIEWPORT_PADDING * 2),
  )
  const left = Math.min(
    Math.max(DROPDOWN_VIEWPORT_PADDING, triggerRect.left),
    window.innerWidth - DROPDOWN_VIEWPORT_PADDING - width,
  )
  const preferredTop = placement === 'bottom'
    ? triggerRect.bottom + DROPDOWN_GAP
    : triggerRect.top - panelHeight - DROPDOWN_GAP
  const top = Math.min(
    Math.max(DROPDOWN_VIEWPORT_PADDING, preferredTop),
    window.innerHeight - DROPDOWN_VIEWPORT_PADDING - panelHeight,
  )

  return { top, left, width, maxHeight, placement }
}

function useDropdownPosition(
  open: boolean,
  triggerRef: RefObject<HTMLDivElement>,
  hasFooter: boolean,
  preferredPlacement: 'auto' | 'bottom' = 'auto',
) {
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<DropdownPosition | null>(null)

  useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setPosition(getDropdownPosition(rect, hasFooter, preferredPlacement))
    }

    updatePosition()
    const frame = window.requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)

    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, triggerRef, hasFooter, preferredPlacement])

  return { dropdownRef, position }
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  label,
  labelAction,
  error,
  hint,
  required,
  disabled,
  loading,
  clearable,
  onAddNew,
  addNewLabel = '+ Add New',
  className = '',
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [focused, setFocused] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const { dropdownRef, position } = useDropdownPosition(open, triggerRef, Boolean(onAddNew))

  const selected = options.find(option => option.value === value)
  const filtered = options.filter(option =>
    String(option.label ?? '').toLowerCase().includes(search.toLowerCase())
    || (option.subtitle && option.subtitle.toLowerCase().includes(search.toLowerCase())),
  )

  const closeDropdown = () => {
    setOpen(false)
    setSearch('')
    setFocused(0)
  }

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return
      closeDropdown()
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownRef])

  useEffect(() => {
    if (!open) return undefined

    const timer = window.setTimeout(() => searchRef.current?.focus(), 50)
    return () => window.clearTimeout(timer)
  }, [open])

  const select = (option: SelectOption) => {
    if (option.disabled) return
    onChange(option.value)
    closeDropdown()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        setOpen(true)
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (filtered.length) setFocused(current => Math.min(current + 1, filtered.length - 1))
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length) setFocused(current => Math.max(current - 1, 0))
    }

    if (event.key === 'Enter' && filtered[focused]) {
      event.preventDefault()
      select(filtered[focused])
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      closeDropdown()
    }
  }

  const dropdown = open && position
    ? createPortal(
      <div
        ref={dropdownRef}
        className="fixed z-[100120] bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          transformOrigin: position.placement === 'top' ? 'bottom center' : 'top center',
        }}
      >
        <div className="p-2 border-b border-gray-100">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              ref={searchRef}
              value={search}
              onChange={event => {
                setSearch(event.target.value)
                setFocused(0)
              }}
              placeholder="Search..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-blue-400"
            />
          </div>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: position.maxHeight }}>
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-gray-400">No results found</div>
          ) : filtered.map((option, index) => (
            <div
              key={option.value}
              onMouseDown={event => {
                event.preventDefault()
                select(option)
              }}
              onMouseEnter={() => setFocused(index)}
              className={[
                'flex items-center justify-between px-3 py-2.5 cursor-pointer transition-colors',
                option.disabled ? 'opacity-40 cursor-not-allowed' : '',
                index === focused ? 'bg-blue-50' : 'hover:bg-gray-50',
              ].join(' ')}
            >
              <div>
                <div className="text-sm font-medium text-gray-800">{option.label}</div>
                {option.subtitle && <div className={option.subtitleClassName || 'text-xs text-gray-400'}>{option.subtitle}</div>}
              </div>
              {value === option.value && <Check size={14} className="text-blue-500 flex-shrink-0" />}
            </div>
          ))}
        </div>

        {onAddNew && (
          <div className="border-t border-gray-100 p-1">
            <button
              type="button"
              onMouseDown={event => {
                event.preventDefault()
                onAddNew()
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-600 font-medium hover:bg-blue-50 rounded-lg transition-colors"
            >
              <Plus size={14} /> {addNewLabel}
            </button>
          </div>
        )}
      </div>,
      document.body,
    )
    : null

  return (
    <FormField
      ref={containerRef}
      label={label}
      labelAction={labelAction}
      required={required}
      error={error}
      hint={hint}
      className={`relative ${className}`}
    >
      <div
        ref={triggerRef}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        onClick={() => !disabled && setOpen(current => !current)}
        className={[
          'form-field-shell relative flex items-center px-2.5 py-1.5 rounded-lg border cursor-pointer text-[13px] transition-all min-h-[34px] focus:outline-none',
          disabled
            ? 'disabled text-gray-400'
            : open
              ? 'open'
              : error
                ? 'error'
                : '',
        ].join(' ')}
      >
        <span className={`flex-1 truncate ${!selected ? 'text-gray-400' : 'text-gray-900'}`}>
          {loading ? 'Loading...' : (selected?.label || placeholder)}
        </span>
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          {clearable && value != null && !disabled && (
            <button
              type="button"
              onMouseDown={event => {
                event.preventDefault()
                event.stopPropagation()
                onChange(null)
              }}
              className="p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
            >
              <X size={12} />
            </button>
          )}
          <ChevronDown size={14} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {dropdown}
    </FormField>
  )
}

interface MultiSelectProps extends Omit<SearchableSelectProps, 'value' | 'onChange' | 'clearable'> {
  value: (string | number)[]
  onChange: (value: (string | number)[]) => void
  /** 'bottom' pins the panel below the field instead of flipping up when space below is tight (e.g. inside a modal). */
  placement?: 'auto' | 'bottom'
}

export function MultiSearchableSelect({
  options,
  value = [],
  onChange,
  placeholder = 'Select items...',
  label,
  labelAction,
  error,
  hint,
  required,
  disabled,
  loading,
  onAddNew,
  addNewLabel = '+ Add New',
  className = '',
  placement = 'auto',
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const { dropdownRef, position } = useDropdownPosition(open, triggerRef, Boolean(onAddNew), placement)

  const selected = options.filter(option => value.includes(option.value))
  const filtered = options.filter(option =>
    String(option.label ?? '').toLowerCase().includes(search.toLowerCase())
    || (option.subtitle && option.subtitle.toLowerCase().includes(search.toLowerCase())),
  )

  const closeDropdown = () => {
    setOpen(false)
    setSearch('')
  }

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node
      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return
      closeDropdown()
    }

    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [dropdownRef])

  useEffect(() => {
    if (!open) return undefined

    const timer = window.setTimeout(() => searchRef.current?.focus(), 50)
    return () => window.clearTimeout(timer)
  }, [open])

  const toggle = (nextValue: string | number) => {
    onChange(value.includes(nextValue)
      ? value.filter(current => current !== nextValue)
      : [...value, nextValue])
  }

  const dropdown = open && position
    ? createPortal(
      <div
        ref={dropdownRef}
        className="fixed z-[100120] bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden"
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          transformOrigin: position.placement === 'top' ? 'bottom center' : 'top center',
        }}
      >
        <div className="p-2 border-b border-gray-100">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              ref={searchRef}
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search..."
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-blue-400"
            />
          </div>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: position.maxHeight }}>
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-gray-400">No results found</div>
          ) : filtered.map(option => (
            <div
              key={option.value}
              onMouseDown={event => {
                event.preventDefault()
                toggle(option.value)
              }}
              className={`flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-gray-50 ${value.includes(option.value) ? 'bg-blue-50' : ''}`}
            >
              <div
                className={[
                  'w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center',
                  value.includes(option.value) ? 'bg-blue-500 border-blue-500' : 'border-gray-300',
                ].join(' ')}
              >
                {value.includes(option.value) && <Check size={10} className="text-white" />}
              </div>
              <div>
                <div className="text-sm font-medium text-gray-800">{option.label}</div>
                {option.subtitle && <div className={option.subtitleClassName || 'text-xs text-gray-400'}>{option.subtitle}</div>}
              </div>
            </div>
          ))}
        </div>

        {onAddNew && (
          <div className="border-t border-gray-100 p-1">
            <button
              type="button"
              onMouseDown={event => {
                event.preventDefault()
                onAddNew()
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-600 font-medium hover:bg-blue-50 rounded-lg"
            >
              <Plus size={14} /> {addNewLabel}
            </button>
          </div>
        )}
      </div>,
      document.body,
    )
    : null

  return (
    <FormField
      ref={containerRef}
      label={label}
      labelAction={labelAction}
      required={required}
      error={error}
      hint={hint}
      className={`relative ${className}`}
    >
      <div
        ref={triggerRef}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={event => {
          if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
            event.preventDefault()
            setOpen(current => !current)
          }
          if (event.key === 'Escape') closeDropdown()
        }}
        onClick={() => !disabled && setOpen(current => !current)}
        className={[
          'form-field-shell flex flex-wrap items-center gap-1.5 px-2.5 py-1.5 rounded-lg border cursor-pointer min-h-[34px] focus:outline-none',
          disabled
            ? 'disabled'
            : open
              ? 'open'
              : error
                ? 'error'
                : '',
        ].join(' ')}
      >
        {selected.length === 0
          ? <span className="text-[13px] text-gray-400">{loading ? 'Loading...' : placeholder}</span>
          : selected.map(option => (
            <span key={option.value} className="flex items-center gap-1 bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded-md">
              {option.label}
              <button
                type="button"
                onMouseDown={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  toggle(option.value)
                }}
                className="hover:text-blue-600"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        <ChevronDown size={14} className={`ml-auto text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </div>

      {dropdown}
    </FormField>
  )
}
