import { useState, useRef, useEffect } from 'react'
import { RefreshCw, Download, Search, X, CalendarRange } from 'lucide-react'
import { useModuleName } from '@/context/ModuleLabelsContext'

export interface AnalyticsFilterState {
  date_from: string
  date_to: string
  owner: string
  region: string
  state: string
  team: string
  status: string
  result: string
  source_portal: string
  business_vertical_id: string
  customer_segment: string
  customer_id: string
  search: string
}

export const EMPTY_ANALYTICS_FILTERS: AnalyticsFilterState = {
  date_from: '',
  date_to: '',
  owner: '',
  region: '',
  state: '',
  team: '',
  status: '',
  result: '',
  source_portal: '',
  business_vertical_id: '',
  customer_segment: '',
  customer_id: '',
  search: '',
}

export interface AnalyticsFilterOptions {
  owners?: { id: number | string; name: string }[]
  regions?: string[]
  states?: string[]
  teams?: string[]
  statuses?: string[]
  results?: string[]
  portals?: string[]
  businessVerticals?: { id: number | string; name: string; subtitle?: string }[]
  segments?: (string | { id: number | string; name: string })[]
  customers?: { id: number | string; name: string }[]
}

const SEL_CLS =
  'h-9 shrink-0 rounded-xl border border-slate-200 bg-slate-50 px-3 text-[12px] text-slate-700 outline-none transition-all focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100'

export function AnalyticsFilterBar({
  filters,
  onChange,
  onReset,
  onRefresh,
  onExport,
  filterOptions,
  loading,
}: {
  filters: AnalyticsFilterState
  onChange: (k: keyof AnalyticsFilterState, v: string) => void
  onReset: () => void
  onRefresh: () => void
  onExport: () => void
  filterOptions: AnalyticsFilterOptions
  loading: boolean
}) {
  const { singular: customerSingular } = useModuleName('customers')
  const [searchLocal, setSearchLocal] = useState(filters.search)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setSearchLocal(filters.search)
  }, [filters.search])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleSearch = (v: string) => {
    setSearchLocal(v)

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(() => {
      onChange('search', v)
    }, 300)
  }

  const activeCount = Object.values(filters).filter(v => v !== '').length

  return (
    <div className="rounded-2xl border border-[#e6eaf1] bg-white p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-0.5">
        <div className="flex h-9 min-w-[230px] shrink-0 items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2 text-[11px] text-slate-500 xl:max-w-[245px]">
          <CalendarRange size={13} className="shrink-0 text-slate-400" />

          <input
            type="date"
            value={filters.date_from}
            onChange={e => onChange('date_from', e.target.value)}
            className="w-full min-w-0 bg-transparent text-[11px] text-slate-700 outline-none"
          />

          <span className="text-slate-300">–</span>

          <input
            type="date"
            value={filters.date_to}
            onChange={e => onChange('date_to', e.target.value)}
            className="w-full min-w-0 bg-transparent text-[11px] text-slate-700 outline-none"
          />
        </div>

        {filterOptions.owners?.length ? (
          <select
            className={`${SEL_CLS} w-[140px]`}
            value={filters.owner}
            onChange={e => onChange('owner', e.target.value)}
          >
            <option value="">Owner: All</option>
            {filterOptions.owners.map(o => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.regions?.length ? (
          <select
            className={`${SEL_CLS} w-[140px]`}
            value={filters.region}
            onChange={e => onChange('region', e.target.value)}
          >
            <option value="">Region: All</option>
            {filterOptions.regions.map(r => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.states?.length ? (
          <select
            className={`${SEL_CLS} w-[140px]`}
            value={filters.state}
            onChange={e => onChange('state', e.target.value)}
          >
            <option value="">State: All</option>
            {filterOptions.states.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.teams?.length ? (
          <select
            className={`${SEL_CLS} w-[140px]`}
            value={filters.team}
            onChange={e => onChange('team', e.target.value)}
          >
            <option value="">Team: All</option>
            {filterOptions.teams.map(t => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.statuses?.length ? (
          <select
            className={`${SEL_CLS} w-[140px]`}
            value={filters.status}
            onChange={e => onChange('status', e.target.value)}
          >
            <option value="">Status: All</option>
            {filterOptions.statuses.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.results?.length ? (
          <select
            className={`${SEL_CLS} w-[130px]`}
            value={filters.result}
            onChange={e => onChange('result', e.target.value)}
          >
            <option value="">Result: All</option>
            {filterOptions.results.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.portals?.length ? (
          <select
            className={`${SEL_CLS} w-[130px]`}
            value={filters.source_portal}
            onChange={e => onChange('source_portal', e.target.value)}
          >
            <option value="">Portal: All</option>
            {filterOptions.portals.map(s => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.businessVerticals?.length ? (
          <select
            className={`${SEL_CLS} w-[175px]`}
            value={filters.business_vertical_id}
            onChange={e => onChange('business_vertical_id', e.target.value)}
          >
            <option value="">Business Unit: All</option>
            {filterOptions.businessVerticals.map(v => (
              <option key={v.id} value={v.id}>
                {v.subtitle ? `${v.name} · ${v.subtitle}` : v.name}
              </option>
            ))}
          </select>
        ) : null}

        {filterOptions.segments?.length ? (
          <select
            className={`${SEL_CLS} w-[160px]`}
            value={filters.customer_segment}
            onChange={e => onChange('customer_segment', e.target.value)}
          >
            <option value="">Segment: All</option>
            {filterOptions.segments.map(s => {
              const id = typeof s === 'string' ? s : s.id
              const name = typeof s === 'string' ? s : s.name
              return (
                <option key={id} value={name}>
                  {name}
                </option>
              )
            })}
          </select>
        ) : null}

        {filterOptions.customers?.length ? (
          <select
            className={`${SEL_CLS} w-[170px]`}
            value={filters.customer_id}
            onChange={e => onChange('customer_id', e.target.value)}
          >
            <option value="">{customerSingular}: All</option>
            {filterOptions.customers.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : null}

        <div className="relative w-[200px] shrink-0">
          <Search
            size={13}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />

          <input
            value={searchLocal}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search..."
            className="h-9 w-full rounded-xl border border-slate-200 bg-slate-50 pl-8 pr-3 text-[12px] text-slate-700 outline-none transition-all focus:border-indigo-400 focus:bg-white focus:ring-2 focus:ring-indigo-100"
          />
        </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {activeCount > 0 ? (
            <button
              onClick={() => {
                setSearchLocal('')
                onReset()
              }}
              className="inline-flex h-9 items-center gap-1 rounded-xl border border-red-100 bg-red-50 px-3 text-[12px] font-medium text-red-600 transition-all hover:bg-red-100"
            >
              <X size={13} />
              Clear
            </button>
          ) : null}

          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:border-slate-400 hover:text-slate-900 disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>

          <button
            onClick={onExport}
            title="Export"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:border-slate-400 hover:text-slate-900"
          >
            <Download size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
