import { useState } from 'react'
import { Filter, Play, ChevronDown, ChevronUp, AlertCircle, Zap } from 'lucide-react'
import type { FilterField, ModuleFilterConfig, UseReportFiltersResult, FieldOption } from './filterTypes'
import { PRESETS } from './filterConfigs'
import { Chip } from '../reportViewShared'

// ─── Field-level renderer ─────────────────────────────────────────────────────

const INPUT_CLS =
  'h-8 px-2.5 text-[12px] border border-gray-200 rounded-lg focus:outline-none focus:border-[var(--color-primary)] bg-white min-w-[120px] max-w-[200px]'

interface FieldRendererProps {
  field: FilterField
  value: string
  onChange: (val: string) => void
  filterOptions: UseReportFiltersResult['filterOptions']
  dateFrom: string
  dateTo: string
  onDateFromChange: (val: string) => void
  onDateToChange: (val: string) => void
}

function MultiSelectDropdown({
  field,
  value,
  onChange,
  options,
}: {
  field: FilterField
  value: string
  onChange: (val: string) => void
  options: FieldOption[]
}) {
  const [open, setOpen] = useState(false)
  const selected = value ? value.split(',').filter(Boolean) : []

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(Array.from(next).join(','))
  }

  const displayLabel =
    selected.length === 0
      ? 'All'
      : selected.length === 1
        ? (options.find(o => String(o.id) === selected[0])?.name ?? selected[0])
        : `${selected.length} selected`

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`${INPUT_CLS} flex items-center justify-between gap-1.5 cursor-pointer select-none w-[160px]`}
      >
        <span className={selected.length ? 'text-gray-900 truncate' : 'text-gray-400 truncate'}>{displayLabel}</span>
        <ChevronDown size={11} className="flex-shrink-0 text-gray-400" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 max-h-64 w-full min-w-[240px] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl">
            {options.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-gray-400">No options</div>
            )}
            {(() => {
              const hasGroups = options.some(o => o.subtitle)
              if (!hasGroups) {
                return options.map(option => {
                  const id = String(option.id)
                  const checked = selected.includes(id)
                  return (
                    <div key={id} className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px] ${checked ? 'bg-[color-mix(in_srgb,var(--color-primary)_8%,white)] text-[var(--color-primary)]' : 'text-gray-700 hover:bg-gray-50'}`} onClick={() => toggle(id)}>
                      <div className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border ${checked ? 'border-[var(--color-primary)] bg-[var(--color-primary)]' : 'border-gray-300'}`}>
                        {checked && <svg viewBox="0 0 10 8" className="h-2.5 w-2.5 fill-white"><path d="M1 4l3 3 5-6" /></svg>}
                      </div>
                      <span className="truncate">{option.name}</span>
                    </div>
                  )
                })
              }
              // Grouped rendering — group consecutive items sharing the same subtitle
              const groups: Array<{ header: string; items: typeof options }> = []
              options.forEach(o => {
                const key = o.subtitle || ''
                const last = groups[groups.length - 1]
                if (last && last.header === key) last.items.push(o)
                else groups.push({ header: key, items: [o] })
              })
              return groups.map((group, gi) => (
                <div key={gi}>
                  {group.header && (
                    <div className="sticky top-0 px-3 py-1 text-[10px] font-bold text-blue-700 uppercase tracking-wider bg-blue-50 border-y border-blue-100">
                      {group.header}
                    </div>
                  )}
                  {group.items.map(option => {
                    const id = String(option.id)
                    const checked = selected.includes(id)
                    return (
                      <div key={id} className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-[12px] ${checked ? 'bg-[color-mix(in_srgb,var(--color-primary)_8%,white)] text-[var(--color-primary)]' : 'text-gray-700 hover:bg-gray-50'}`} onClick={() => toggle(id)}>
                        <div className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border ${checked ? 'border-[var(--color-primary)] bg-[var(--color-primary)]' : 'border-gray-300'}`}>
                          {checked && <svg viewBox="0 0 10 8" className="h-2.5 w-2.5 fill-white"><path d="M1 4l3 3 5-6" /></svg>}
                        </div>
                        <span className="truncate">{option.name}</span>
                      </div>
                    )
                  })}
                </div>
              ))
            })()}
            {selected.length > 0 && (
              <div className="border-t border-gray-100 p-2">
                <button
                  onClick={() => { onChange(''); setOpen(false) }}
                  className="w-full text-center text-[11px] text-gray-500 hover:text-red-500 transition-colors"
                >
                  Clear
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function FieldRenderer({
  field,
  value,
  onChange,
  filterOptions,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
}: FieldRendererProps) {
  if (field.fieldType === 'preset') {
    return (
      <div className="flex items-end gap-2">
        <div>
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5 block">
            {field.label}
          </span>
          <select
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            className={INPUT_CLS}
          >
            {PRESETS.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {value === 'custom' && (
          <>
            <div>
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5 block">From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={e => onDateFromChange(e.target.value)}
                className={INPUT_CLS}
              />
            </div>
            <div>
              <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5 block">To</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => onDateToChange(e.target.value)}
                className={INPUT_CLS}
              />
            </div>
          </>
        )}
      </div>
    )
  }

  if (field.fieldType === 'select') {
    const opts: FieldOption[] = field.options
      ? field.options
      : field.optionsKey
        ? (filterOptions[field.optionsKey] ?? [])
        : []
    return (
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className={INPUT_CLS}
      >
        <option value="">{field.placeholder ?? `All ${field.label}`}</option>
        {opts.map(o => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
    )
  }

  if (field.fieldType === 'multi_select') {
    const opts: FieldOption[] = field.options
      ? field.options
      : field.optionsKey
        ? (filterOptions[field.optionsKey] ?? [])
        : []
    const hasGroups = opts.some(o => o.subtitle)
    if (hasGroups) {
      const groups: Array<{ header: string; items: typeof opts }> = []
      opts.forEach(o => {
        const key = o.subtitle || ''
        const last = groups[groups.length - 1]
        if (last && last.header === key) last.items.push(o)
        else groups.push({ header: key, items: [o] })
      })
      return (
        <select value={value || ''} onChange={e => onChange(e.target.value)} className={`${INPUT_CLS} w-[180px] max-w-[220px]`}>
          <option value="">All</option>
          {groups.map((g, gi) =>
            g.header ? (
              <optgroup key={gi} label={g.header}>
                {g.items.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </optgroup>
            ) : (
              g.items.map(o => <option key={o.id} value={o.id}>{o.name}</option>)
            )
          )}
        </select>
      )
    }
    return (
      <MultiSelectDropdown
        field={field}
        value={value}
        onChange={onChange}
        options={opts}
      />
    )
  }

  if (field.fieldType === 'text') {
    return (
      <input
        type="text"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={field.placeholder ?? `Filter ${field.label}…`}
        className={INPUT_CLS}
      />
    )
  }

  if (field.fieldType === 'number') {
    return (
      <input
        type="number"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        placeholder={field.placeholder ?? ''}
        className={INPUT_CLS}
      />
    )
  }

  if (field.fieldType === 'date') {
    return (
      <input
        type="date"
        value={value || ''}
        onChange={e => onChange(e.target.value)}
        className={INPUT_CLS}
      />
    )
  }

  if (field.fieldType === 'existence') {
    const active = value === '1'
    return (
      <button
        type="button"
        onClick={() => onChange(active ? '' : '1')}
        className={`h-8 px-3 rounded-lg text-[12px] font-medium border transition-colors ${
          active
            ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,white)]'
            : 'border-gray-200 text-gray-500 hover:border-gray-300 bg-white'
        }`}
      >
        {active ? 'Yes Only' : 'All'}
      </button>
    )
  }

  return null
}

// ─── FieldBlock: label + field renderer ──────────────────────────────────────

interface FieldBlockProps {
  field: FilterField
  rf: UseReportFiltersResult
}

function FieldBlock({ field, rf }: FieldBlockProps) {
  if (field.fieldType === 'preset') {
    // Preset renders its own label structure
    return (
      <FieldRenderer
        field={field}
        value={rf.staged[field.key] ?? ''}
        onChange={val => { rf.setFilter(field.key, val); if (val !== 'custom') rf.run() }}
        filterOptions={rf.filterOptions}
        dateFrom={rf.staged['date_from'] ?? ''}
        dateTo={rf.staged['date_to'] ?? ''}
        onDateFromChange={val => rf.setFilter('date_from', val)}
        onDateToChange={val => rf.setFilter('date_to', val)}
      />
    )
  }

  const resolvedOpts = field.options ?? (field.optionsKey ? (rf.filterOptions[field.optionsKey] ?? []) : [])
  const isGroupedMultiSelect = field.fieldType === 'multi_select' && resolvedOpts.some(o => o.subtitle)
  const autoRun = field.fieldType === 'select' || field.fieldType === 'existence' || isGroupedMultiSelect

  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-0.5 block">
        {field.label}
      </span>
      <FieldRenderer
        field={field}
        value={rf.staged[field.key] ?? ''}
        onChange={val => { rf.setFilter(field.key, val); if (autoRun) rf.run() }}
        filterOptions={rf.filterOptions}
        dateFrom={rf.staged['date_from'] ?? ''}
        dateTo={rf.staged['date_to'] ?? ''}
        onDateFromChange={val => rf.setFilter('date_from', val)}
        onDateToChange={val => rf.setFilter('date_to', val)}
      />
    </div>
  )
}

// ─── ReportFilterBar ──────────────────────────────────────────────────────────

interface ReportFilterBarProps {
  config: ModuleFilterConfig
  rf: UseReportFiltersResult
  loading: boolean
  rightActions?: React.ReactNode
  hideFieldKeys?: string[]
}

export function ReportFilterBar({ config, rf, loading, rightActions, hideFieldKeys = [] }: ReportFilterBarProps) {
  const [showFilters, setShowFilters] = useState(true)
  const [showMore, setShowMore] = useState(false)
  const hiddenFieldKeys = new Set(['preset', ...hideFieldKeys])
  const isVisibleField = (field: FilterField) => !hiddenFieldKeys.has(field.key)
  const primaryFields = config.primaryFields.filter(isVisibleField)
  const secondaryFields = config.secondaryFields.filter(isVisibleField)
  const moreFields = config.moreFields.filter(isVisibleField)

  const hasFilters = primaryFields.length > 0 || secondaryFields.length > 0 || moreFields.length > 0
  const hasMore = moreFields.length > 0

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4 shadow-sm">
      {/* ── Primary row ── */}
      <div className="flex items-end gap-3 flex-wrap">
        {showFilters && primaryFields.map(f => (
          <FieldBlock key={f.key} field={f} rf={rf} />
        ))}

        {/* Right-side actions */}
        <div className="ml-auto flex items-end gap-2 flex-shrink-0">
          {rightActions}

          {/* Run button */}
          <button
            onClick={rf.run}
            disabled={loading}
            style={{ background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-accent) 100%)' }}
            className="h-8 px-4 rounded-lg text-[12px] font-semibold text-white flex items-center gap-1.5 disabled:opacity-60 shadow-sm hover:shadow-md transition-shadow"
          >
            <Play size={12} /> Run
          </button>

          {hasFilters && (
            <button
              onClick={() => setShowFilters(v => !v)}
              className={`h-8 px-3 rounded-lg text-[12px] font-medium border flex items-center gap-1.5 transition-colors ${
                showFilters || rf.chips.length > 0
                  ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,white)]'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              <Filter size={12} />
              Filters
              {rf.chips.length > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-primary)] text-white">
                  {rf.chips.length}
                </span>
              )}
              {showFilters ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}

          {/* More Filters toggle */}
          {showFilters && hasMore && (
            <button
              onClick={() => setShowMore(v => !v)}
              className={`h-8 px-3 rounded-lg text-[12px] font-medium border flex items-center gap-1.5 transition-colors ${
                showMore || rf.activeMoreCount > 0
                  ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,white)]'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              <Filter size={12} />
              More
              {rf.activeMoreCount > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[var(--color-primary)] text-white">
                  {rf.activeMoreCount}
                </span>
              )}
              {showMore ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}
        </div>
      </div>

      {/* ── Secondary row ── */}
      {showFilters && secondaryFields.length > 0 && (
        <div className="flex items-end gap-3 flex-wrap mt-3 pt-3 border-t border-gray-100">
          {secondaryFields.map(f => (
            <FieldBlock key={f.key} field={f} rf={rf} />
          ))}
        </div>
      )}

      {/* ── More Filters inline row ── */}
      {showFilters && showMore && hasMore && (
        <div className="mt-3 pt-3 border-t border-dashed border-gray-200">
          <div className="flex items-center gap-1.5 mb-2">
            <Filter size={11} className="text-gray-400" />
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Additional Filters</span>
          </div>
          <div className="flex items-end gap-3 flex-wrap">
            {moreFields.map(f => (
              <FieldBlock key={f.key} field={f} rf={rf} />
            ))}
          </div>
        </div>
      )}

      {/* ── Chips row ── */}
      {rf.chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <span className="text-[11px] text-gray-400 font-medium">Applied:</span>
          {rf.chips.map(c => (
            <Chip
              key={c.key}
              label={c.label}
              onRemove={() => rf.removeChip(c.key)}
              tone="border-blue-200 bg-blue-50 text-blue-700"
            />
          ))}
          {rf.chips.length > 1 && (
            <button
              className="text-[11px] text-gray-400 hover:text-red-500 transition-colors ml-1"
              onClick={rf.clearAll}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* ── Dirty banner ── */}
      {rf.isDirty && (
        <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-[12px] font-medium">
          <AlertCircle size={13} />
          Filters changed — click Run to update the report.
        </div>
      )}

      {/* ── Quick filters row ── */}
      {config.quickFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <span className="text-[11px] text-gray-400 font-medium flex items-center gap-1">
            <Zap size={10} />Quick:
          </span>
          {config.quickFilters.map(qf => (
            <button
              key={qf.key}
              onClick={() => rf.applyQuickFilter(qf.params)}
              className="h-6 px-2.5 rounded-full border text-[11px] font-medium border-gray-200 text-gray-600 hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-primary)_6%,white)] transition-colors"
            >
              {qf.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
