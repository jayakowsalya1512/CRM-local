import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Search, Users, Target, FileText, Briefcase, Package,
  ChevronLeft, ChevronRight as ChevronRightIcon, ArrowUpRight, X,
} from 'lucide-react'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface SearchItem {
  id: number
  module: string
  title: string
  subtitle?: string | null
  ref_id?: string | null
  status?: string | null
  assigned_to_name?: string | null
  url: string
}

interface ModuleResult {
  items: SearchItem[]
  total: number | null
}

interface SearchResults {
  customers:     ModuleResult
  leads:         ModuleResult
  opportunities: ModuleResult
  tenders:       ModuleResult
  workorders:    ModuleResult
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const MODULE_META: Record<string, {
  label: string
  icon: React.ReactNode
  color: string
  bg: string
  border: string
}> = {
  customers:     { label: 'Customers',     icon: <Users size={14} />,     color: 'text-blue-600',   bg: 'bg-blue-50',   border: 'border-blue-200'   },
  leads:         { label: 'Leads',         icon: <Target size={14} />,    color: 'text-indigo-600', bg: 'bg-indigo-50', border: 'border-indigo-200' },
  opportunities: { label: 'Opportunities', icon: <Briefcase size={14} />, color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-200' },
  tenders:       { label: 'Tenders',       icon: <FileText size={14} />,  color: 'text-amber-600',  bg: 'bg-amber-50',  border: 'border-amber-200'  },
  workorders:    { label: 'Orders & Projects',   icon: <Package size={14} />,   color: 'text-emerald-600',bg: 'bg-emerald-50',border: 'border-emerald-200' },
}

const MODULE_ORDER = ['customers', 'leads', 'opportunities', 'tenders', 'workorders'] as const
const PAGE_SIZE = 20

// ─── Highlight ─────────────────────────────────────────────────────────────────

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text) return <span>{text}</span>
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5 font-semibold not-italic">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </span>
  )
}

// ─── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return null
  const map: Record<string, string> = {
    Converted:   'bg-green-100 text-green-700',
    'Opportunity Created': 'bg-purple-100 text-purple-700',
    Assigned:    'bg-blue-100 text-blue-700',
    Qualified:   'bg-indigo-100 text-indigo-700',
    Lost:        'bg-red-100 text-red-600',
    Active:      'bg-green-100 text-green-700',
    Inactive:    'bg-gray-100 text-gray-500',
    Submitted:   'bg-blue-100 text-blue-700',
    Aligned:     'bg-amber-100 text-amber-700',
    Completed:   'bg-green-100 text-green-700',
    Draft:       'bg-gray-100 text-gray-500',
    'In Progress': 'bg-blue-100 text-blue-700',
  }
  const cls = map[status] || 'bg-gray-100 text-gray-500'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {status}
    </span>
  )
}

// ─── Result Row ────────────────────────────────────────────────────────────────

function ResultRow({ item, query, onClick }: { item: SearchItem; query: string; onClick: () => void }) {
  const meta = MODULE_META[item.module]
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-4 p-4 border-b border-gray-50 hover:bg-blue-50/50 transition-colors text-left group"
    >
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${meta.bg} ${meta.color}`}>
        {meta.icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-800">
            <Highlight text={item.title} query={query} />
          </span>
          {item.ref_id && (
            <span className={`text-xs font-mono px-2 py-0.5 rounded border ${meta.bg} ${meta.color} ${meta.border}`}>
              <Highlight text={item.ref_id} query={query} />
            </span>
          )}
          <StatusBadge status={item.status} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {item.subtitle && (
            <span className="text-xs text-gray-500 truncate">
              <Highlight text={item.subtitle} query={query} />
            </span>
          )}
          {item.assigned_to_name && (
            <span className="text-xs text-gray-400 flex-shrink-0">· {item.assigned_to_name}</span>
          )}
        </div>
      </div>
      <ArrowUpRight
        size={15}
        className="flex-shrink-0 text-gray-300 group-hover:text-blue-500 transition-colors"
      />
    </button>
  )
}

// ─── Pagination ────────────────────────────────────────────────────────────────

function Pagination({
  page, total, pageSize, onChange,
}: { page: number; total: number; pageSize: number; onChange: (p: number) => void }) {
  const totalPages = Math.ceil(total / pageSize)
  if (totalPages <= 1) return null
  return (
    <div className="flex items-center justify-center gap-2 py-4">
      <button
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronLeft size={14} />
      </button>
      {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
        let p: number
        if (totalPages <= 7) p = i + 1
        else if (page <= 4) p = i + 1
        else if (page >= totalPages - 3) p = totalPages - 6 + i
        else p = page - 3 + i
        return (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
              p === page
                ? 'bg-blue-600 text-white'
                : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {p}
          </button>
        )
      })}
      <button
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        className="p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ChevronRightIcon size={14} />
      </button>
    </div>
  )
}

// ─── Main page ─────────────────────────────────────────────────────────────────

export default function SearchResultsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { label: customerLabel, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, labelLower: leadLabelLower } = useModuleName('leads')
  const { label: opportunityLabel, labelLower: opportunityLabelLower } = useModuleName('opportunities')
  const { label: tenderLabel, labelLower: tenderLabelLower } = useModuleName('tenders')
  const { label: workOrderLabel, labelLower: workOrderLabelLower } = useModuleName('workorders')
  const moduleLabels: Record<string, string> = {
    customers: customerLabel,
    leads: leadLabel,
    opportunities: opportunityLabel,
    tenders: tenderLabel,
    workorders: workOrderLabel,
  }

  const q         = searchParams.get('q') || ''
  const moduleFilter = searchParams.get('module') || ''
  const page      = parseInt(searchParams.get('page') || '1', 10)

  const [query, setQuery]     = useState(q)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchResults = useCallback(async (term: string, mod: string, pg: number) => {
    if (!term.trim()) { setResults(null); return }
    setLoading(true)
    try {
      const params = new URLSearchParams({ q: term.trim(), page: String(pg), page_size: String(PAGE_SIZE) })
      if (mod) params.set('module', mod)
      const r = await api.get(`/search?${params.toString()}`)
      setResults(r.data)
    } catch {
      setResults(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchResults(q, moduleFilter, page)
  }, [q, moduleFilter, page, fetchResults])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    const newParams = new URLSearchParams({ q: query.trim() })
    if (moduleFilter) newParams.set('module', moduleFilter)
    newParams.set('page', '1')
    setSearchParams(newParams)
  }

  const setModule = (mod: string) => {
    const newParams = new URLSearchParams(searchParams)
    if (mod) newParams.set('module', mod)
    else newParams.delete('module')
    newParams.set('page', '1')
    setSearchParams(newParams)
  }

  const setPage = (p: number) => {
    const newParams = new URLSearchParams(searchParams)
    newParams.set('page', String(p))
    setSearchParams(newParams)
  }

  const goToItem = (item: SearchItem) => {
    navigate(item.url)
  }

  // Summary counts
  const totalAll = results
    ? MODULE_ORDER.reduce((s, m) => s + (results[m]?.total ?? results[m]?.items?.length ?? 0), 0)
    : 0

  const activeModuleItems  = moduleFilter && results ? results[moduleFilter as keyof SearchResults]?.items ?? [] : []
  const activeModuleTotal  = moduleFilter && results ? results[moduleFilter as keyof SearchResults]?.total ?? activeModuleItems.length : 0
  const activeModuleMeta = moduleFilter && MODULE_META[moduleFilter]
    ? { ...MODULE_META[moduleFilter], label: moduleLabels[moduleFilter] || MODULE_META[moduleFilter].label }
    : null

  return (
    <div className="min-h-screen bg-gray-50/50">
      <div className="max-w-4xl mx-auto px-4 py-6">

        {/* Search bar */}
        <form onSubmit={handleSearch} className="mb-6">
          <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
            <Search size={18} className="text-gray-400 flex-shrink-0" />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Search ${customerLabelLower}, ${leadLabelLower}, ${tenderLabelLower}, ${opportunityLabelLower}, ${workOrderLabelLower}...`}
              className="flex-1 text-sm text-gray-800 placeholder:text-gray-400 outline-none bg-transparent"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); setSearchParams({}) }}
                className="p-1 rounded-lg text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={14} />
              </button>
            )}
            <button
              type="submit"
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              Search
            </button>
          </div>
        </form>

        {/* Module filter tabs */}
        {results && totalAll > 0 && (
          <div className="flex items-center gap-1.5 mb-5 flex-wrap">
            <button
              onClick={() => setModule('')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                !moduleFilter
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300 hover:text-blue-600'
              }`}
            >
              All
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                !moduleFilter ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-500'
              }`}>
                {totalAll}
              </span>
            </button>
            {MODULE_ORDER.map(mod => {
              const cnt = results[mod]?.total ?? results[mod]?.items?.length ?? 0
              if (cnt === 0) return null
              const baseMeta = MODULE_META[mod]
              const meta = { ...baseMeta, label: moduleLabels[mod] || baseMeta.label }
              const active = moduleFilter === mod
              return (
                <button
                  key={mod}
                  onClick={() => setModule(mod)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                    active
                      ? `${meta.bg} ${meta.color} ${meta.border}`
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {meta.icon}
                  {meta.label}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                    active ? `${meta.color} bg-white/60` : 'bg-gray-100 text-gray-500'
                  }`}>
                    {cnt}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="flex items-center gap-4 p-4 border-b border-gray-50">
                <div className="w-9 h-9 rounded-xl bg-gray-100 animate-pulse flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 bg-gray-100 rounded animate-pulse w-48" />
                  <div className="h-2.5 bg-gray-100 rounded animate-pulse w-32" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* No query */}
        {!q && !loading && (
          <div className="flex flex-col items-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
              <Search size={24} className="text-gray-300" />
            </div>
            <p className="text-base font-semibold text-gray-600">Enter a search term above</p>
            <p className="text-sm text-gray-400 mt-1">Search across all modules</p>
          </div>
        )}

        {/* No results */}
        {q && !loading && results && totalAll === 0 && (
          <div className="flex flex-col items-center py-20 text-center">
            <p className="text-base font-semibold text-gray-600">No results for "{q}"</p>
            <p className="text-sm text-gray-400 mt-1">Try a different search term</p>
          </div>
        )}

        {/* Results — single module (paginated) */}
        {!loading && results && moduleFilter && activeModuleItems.length > 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            <div className={`flex items-center gap-2 px-4 py-3 border-b ${activeModuleMeta?.border || 'border-gray-100'}`}>
              <span className={`${activeModuleMeta?.color}`}>{activeModuleMeta?.icon}</span>
              <span className={`text-sm font-bold ${activeModuleMeta?.color}`}>
                {activeModuleMeta?.label}
              </span>
              <span className="text-xs text-gray-400 ml-auto">
                {activeModuleTotal} result{activeModuleTotal !== 1 ? 's' : ''}
              </span>
            </div>
            {activeModuleItems.map(item => (
              <ResultRow key={item.id} item={item} query={q} onClick={() => goToItem(item)} />
            ))}
            <Pagination page={page} total={activeModuleTotal} pageSize={PAGE_SIZE} onChange={setPage} />
          </div>
        )}

        {/* Results — all modules */}
        {!loading && results && !moduleFilter && totalAll > 0 && (
          <div className="space-y-4">
            {MODULE_ORDER.map(mod => {
              const group = results[mod]
              if (!group?.items?.length) return null
              const baseMeta = MODULE_META[mod]
              const meta = { ...baseMeta, label: moduleLabels[mod] || baseMeta.label }
              const total = group.total ?? group.items.length
              return (
                <div key={mod} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                  <div className={`flex items-center gap-2 px-4 py-3 border-b ${meta.border}`}>
                    <span className={meta.color}>{meta.icon}</span>
                    <span className={`text-sm font-bold ${meta.color}`}>{meta.label}</span>
                    <span className="text-xs text-gray-400 ml-auto">{total} result{total !== 1 ? 's' : ''}</span>
                    <button
                      onClick={() => setModule(mod)}
                      className={`flex items-center gap-1 text-xs font-semibold ${meta.color} hover:underline ml-2`}
                    >
                      View all <ChevronRightIcon size={11} />
                    </button>
                  </div>
                  {group.items.map(item => (
                    <ResultRow key={item.id} item={item} query={q} onClick={() => goToItem(item)} />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
