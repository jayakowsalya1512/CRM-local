export type FieldType = 'preset' | 'select' | 'multi_select' | 'text' | 'number' | 'date' | 'existence'

export interface FieldOption {
  id: string | number
  name: string
  subtitle?: string
}

export interface FilterField {
  key: string
  label: string
  fieldType: FieldType
  options?: FieldOption[]        // static options list
  optionsKey?: string            // key in FilterOptionsMap for dynamic/API-loaded options
  placeholder?: string
  section: 'primary' | 'secondary' | 'more'
}

export interface QuickFilter {
  key: string
  label: string
  params: Record<string, string>
}

export type FilterOptionsMap = Record<string, FieldOption[]>

/** Convert a string[] or {id,name}[] to FieldOption[] for FilterOptionsMap */
export function toOptions(items: (string | FieldOption)[]): FieldOption[] {
  return items.map(i => (typeof i === 'string' ? { id: i, name: i } : i))
}

export interface ModuleFilterConfig {
  module: string
  defaultParams: Record<string, string>
  primaryFields: FilterField[]
  secondaryFields: FilterField[]
  moreFields: FilterField[]
  quickFilters: QuickFilter[]
}

export interface UseReportFiltersResult {
  staged: Record<string, string>
  applied: Record<string, string>
  isDirty: boolean
  activeMoreCount: number
  setFilter: (key: string, val: string) => void
  removeChip: (key: string) => void
  clearAll: () => void
  run: () => void
  applyQuickFilter: (params: Record<string, string>) => void
  filterOptions: FilterOptionsMap
  optionsLoading: boolean
  chips: Array<{ key: string; label: string }>
}
