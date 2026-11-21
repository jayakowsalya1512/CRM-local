import { useState, useCallback, useMemo, useRef, useEffect, useContext } from 'react'
import type { ModuleFilterConfig, FilterOptionsMap, UseReportFiltersResult } from './filterTypes'
import { ReportDateRangeCtx } from '../reportToolbarContext'

export function useReportFilters(
  config: ModuleFilterConfig,
  filterOptionsLoader: (() => Promise<FilterOptionsMap>) | null,
  onRun: (applied: Record<string, string>) => void,
): UseReportFiltersResult {
  const globalDr = useContext(ReportDateRangeCtx)

  const buildWithGlobalDateRange = useCallback((baseParams: Record<string, string>): Record<string, string> => {
    const next: Record<string, string> = { ...baseParams, preset: globalDr.preset || '' }
    if (globalDr.preset === 'custom') {
      next.date_from = globalDr.date_from || ''
      next.date_to = globalDr.date_to || ''
    } else {
      next.date_from = ''
      next.date_to = ''
    }
    return next
  }, [globalDr.preset, globalDr.date_from, globalDr.date_to])

  // Initialize staged/applied with global date range if already set when the
  // report view mounts (handles tab-switching after the user picked a preset).
  const buildInit = (): Record<string, string> => {
    return buildWithGlobalDateRange(config.defaultParams)
  }

  const [staged, setStaged] = useState<Record<string, string>>(buildInit)
  const [applied, setApplied] = useState<Record<string, string>>(buildInit)

  // Keep mutable refs so event-handler callbacks are always fresh without needing
  // them in useCallback dependency arrays (prevents toolbar effect from re-firing
  // on every keystroke when staged changes).
  const onRunRef = useRef(onRun)
  const stagedRef = useRef(staged)
  const appliedRef = useRef(applied)
  onRunRef.current = onRun
  stagedRef.current = staged
  appliedRef.current = applied
  const [filterOptions, setFilterOptions] = useState<FilterOptionsMap>({})
  const [optionsLoading, setOptionsLoading] = useState(!!filterOptionsLoader)

  useEffect(() => {
    if (!filterOptionsLoader) return
    setOptionsLoading(true)
    filterOptionsLoader()
      .then(opts => { setFilterOptions(opts); setOptionsLoading(false) })
      .catch(() => setOptionsLoading(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // When the common date-range toolbar changes (after mount), sync preset into
  // this report's filters and immediately re-run — skip the very first render
  // because each report view's mount effect already loads data.
  const isMounted = useRef(false)
  const skipNextGlobalDateSync = useRef(false)
  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return }
    if (skipNextGlobalDateSync.current) { skipNextGlobalDateSync.current = false; return }
    const patch: Record<string, string> = { preset: globalDr.preset }
    if (globalDr.preset === 'custom') {
      patch.date_from = globalDr.date_from
      patch.date_to = globalDr.date_to
    } else {
      patch.date_from = ''
      patch.date_to = ''
    }
    const newApplied = { ...appliedRef.current, ...patch }
    setApplied(newApplied)
    setStaged(prev => ({ ...prev, ...patch }))
    onRunRef.current(newApplied)
  }, [globalDr.preset, globalDr.date_from, globalDr.date_to]) // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = useMemo(() => {
    const keys = new Set([...Object.keys(staged), ...Object.keys(applied)])
    for (const k of keys) {
      if ((staged[k] ?? '') !== (applied[k] ?? '')) return true
    }
    return false
  }, [staged, applied])

  const setFilter = useCallback((key: string, val: string) => {
    setStaged(p => ({ ...p, [key]: val }))
  }, [])

  // run/removeChip/clearAll/applyQuickFilter are all stable — they read state via
  // refs so their identity never changes, eliminating toolbar effect flicker.
  const run = useCallback(() => {
    const newApplied = { ...stagedRef.current }
    setApplied(newApplied)
    onRunRef.current(newApplied)
  }, [])

  const removeChip = useCallback((key: string) => {
    const def = config.defaultParams[key] ?? ''
    const newApplied = { ...appliedRef.current, [key]: def }
    const newStaged = { ...stagedRef.current, [key]: def }
    setApplied(newApplied)
    setStaged(newStaged)
    onRunRef.current(newApplied)
  }, [config.defaultParams])

  const clearAll = useCallback(() => {
    const defaults = buildWithGlobalDateRange(config.defaultParams)
    setStaged(defaults)
    setApplied(defaults)
    onRunRef.current(defaults)
  }, [config.defaultParams, buildWithGlobalDateRange])

  const applyQuickFilter = useCallback((params: Record<string, string>) => {
    setStaged(p => ({ ...p, ...params }))
    const newApp = { ...appliedRef.current, ...params }
    setApplied(newApp)
    onRunRef.current(newApp)
    const datePatch: Partial<{ preset: string; date_from: string; date_to: string }> = {}
    if (Object.prototype.hasOwnProperty.call(params, 'preset')) {
      datePatch.preset = params.preset || ''
      if (params.preset !== 'custom') {
        datePatch.date_from = ''
        datePatch.date_to = ''
      }
    }
    if (Object.prototype.hasOwnProperty.call(params, 'date_from')) datePatch.date_from = params.date_from || ''
    if (Object.prototype.hasOwnProperty.call(params, 'date_to')) datePatch.date_to = params.date_to || ''

    const datePatchEntries = Object.entries(datePatch)
    const willChangeGlobalDate = datePatchEntries.some(([key, value]) =>
      (globalDr[key as 'preset' | 'date_from' | 'date_to'] ?? '') !== value
    )
    if (willChangeGlobalDate) {
      skipNextGlobalDateSync.current = true
      globalDr.setDateRange(datePatch)
    }
  }, [globalDr])

  const activeMoreCount = useMemo(() => {
    return config.moreFields.filter(f => {
      const v = applied[f.key]
      return v && v !== (config.defaultParams[f.key] ?? '')
    }).length
  }, [config.moreFields, applied, config.defaultParams])

  // Build chips from applied filters (skip defaults, skip preset fields)
  const chips = useMemo(() => {
    const result: Array<{ key: string; label: string }> = []
    const allFields = [...config.primaryFields, ...config.secondaryFields, ...config.moreFields]
    for (const field of allFields) {
      if (field.fieldType === 'preset') continue // preset shown inline, not as chip
      const val = applied[field.key]
      if (!val || val === (config.defaultParams[field.key] ?? '')) continue
      let displayVal = val
      // Resolve display label: multi_select first (handles comma-separated ids),
      // then static options, then dynamic optionsKey, then existence boolean
      if (field.fieldType === 'multi_select' && val) {
        const ids = val.split(',').filter(Boolean)
        const opts = field.optionsKey ? (filterOptions[field.optionsKey] || []) : (field.options || [])
        const names = ids.map(id => {
          const found = opts.find(o => String(o.id) === id)
          return found ? found.name : id
        })
        displayVal = names.join(', ')
      } else if (field.options) {
        const opt = field.options.find(o => String(o.id) === val)
        if (opt) displayVal = opt.name
      } else if (field.optionsKey && filterOptions[field.optionsKey]) {
        const opt = filterOptions[field.optionsKey].find(o => String(o.id) === val)
        if (opt) displayVal = opt.name
      } else if (field.fieldType === 'existence') {
        displayVal = val === '1' ? 'Yes' : 'No'
      }
      result.push({ key: field.key, label: `${field.label}: ${displayVal}` })
    }
    return result
  }, [applied, config, filterOptions])

  return {
    staged,
    applied,
    isDirty,
    activeMoreCount,
    setFilter,
    removeChip,
    clearAll,
    run,
    applyQuickFilter,
    filterOptions,
    optionsLoading,
    chips,
  }
}
