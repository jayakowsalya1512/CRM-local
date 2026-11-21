import { createContext, type ReactNode } from 'react'

/**
 * Context that lets any dedicated report view register its action-bar
 * buttons so ReportsPage can render them above the tab strip.
 * Call setToolbar(jsx) in a useEffect; call setToolbar(null) on cleanup.
 */
export const ReportToolbarCtx = createContext<(el: ReactNode) => void>(() => {})

export interface ReportDateRangeContextValue {
  preset: string
  date_from: string
  date_to: string
  params: Record<string, string>
  setPreset: (value: string) => void
  setDateFrom: (value: string) => void
  setDateTo: (value: string) => void
  setDateRange: (next: Partial<Pick<ReportDateRangeContextValue, 'preset' | 'date_from' | 'date_to'>>) => void
}

export const ReportDateRangeCtx = createContext<ReportDateRangeContextValue>({
  preset: '',
  date_from: '',
  date_to: '',
  params: { preset: '', date_from: '', date_to: '' },
  setPreset: () => {},
  setDateFrom: () => {},
  setDateTo: () => {},
  setDateRange: () => {},
})
