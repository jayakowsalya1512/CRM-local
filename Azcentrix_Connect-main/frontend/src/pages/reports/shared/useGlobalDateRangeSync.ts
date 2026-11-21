import { useContext, useEffect, useRef } from 'react'
import { ReportDateRangeCtx } from '../reportToolbarContext'
import { resolvePresetRange } from './presetDateRange'

/**
 * Reads the common date-range toolbar's CURRENT value synchronously, for
 * seeding a view's initial filter state (via useState's lazy initializer) so
 * the view's own first-load fetch already reflects an already-selected
 * preset — e.g. after switching tabs — instead of racing a second, later
 * fetch against the toolbar sync effect below.
 */
export function useInitialGlobalDateRange(): { date_from: string; date_to: string } {
  const globalDr = useContext(ReportDateRangeCtx)
  if (!globalDr.preset) return { date_from: '', date_to: '' }
  const range = globalDr.preset === 'custom'
    ? { date_from: globalDr.date_from, date_to: globalDr.date_to }
    : resolvePresetRange(globalDr.preset)
  return range || { date_from: '', date_to: '' }
}

/**
 * Lets an AnalyticsFilterBar-based report view react to LATER changes on the
 * common date-range toolbar in ReportsPage (the initial value is handled by
 * useInitialGlobalDateRange above, seeded into the view's own state before
 * this effect ever runs). Skips the first render so it doesn't re-fire the
 * fetch the view's mount effect already made with that seeded value.
 */
export function useGlobalDateRangeSync(onRangeChange: (date_from: string, date_to: string) => void) {
  const globalDr = useContext(ReportDateRangeCtx)
  const cbRef = useRef(onRangeChange)
  cbRef.current = onRangeChange

  const isMounted = useRef(false)
  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return }
    const range = globalDr.preset === 'custom'
      ? { date_from: globalDr.date_from, date_to: globalDr.date_to }
      : resolvePresetRange(globalDr.preset)
    if (range) cbRef.current(range.date_from || '', range.date_to || '')
  }, [globalDr.preset, globalDr.date_from, globalDr.date_to]) // eslint-disable-line react-hooks/exhaustive-deps
}
