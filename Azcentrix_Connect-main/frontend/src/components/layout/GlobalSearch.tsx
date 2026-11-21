import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Search, X, Clock, Users, Target, FileText, Briefcase, Package,
  ArrowUpRight, Plane, Shield, Building2, BookOpen, Swords, Sparkles,
  Bot, ListFilter,
} from 'lucide-react'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'

// ─── Constants ────────────────────────────────────────────────────────────────

const RECENT_KEY = 'crm_recent_searches'
const MAX_RECENT = 6
const DEBOUNCE_MS = 300
const SHOW_AI_SEARCH = false
const SHOW_SMART_SEARCH = false

const MODULE_META: Record<string, {
  label: string
  icon: React.ReactNode
  color: string
  bg: string
  border: string
}> = {
  customers:     { label: 'Customers',     icon: <Users size={12} />,     color: 'text-blue-600',   bg: 'bg-blue-50',   border: 'border-blue-200'   },
  leads:         { label: 'Leads',         icon: <Target size={12} />,    color: 'text-indigo-600', bg: 'bg-indigo-50', border: 'border-indigo-200' },
  opportunities: { label: 'Opportunities', icon: <Briefcase size={12} />, color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-200' },
  tenders:       { label: 'Tenders',       icon: <FileText size={12} />,  color: 'text-amber-600',  bg: 'bg-amber-50',  border: 'border-amber-200'  },
  workorders:    { label: 'Orders & Projects',   icon: <Package size={12} />,   color: 'text-emerald-600',bg: 'bg-emerald-50',border: 'border-emerald-200' },
  travel:        { label: 'Travel',        icon: <Plane size={12} />,     color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200' },
  emdbg:         { label: 'EMD / BG',      icon: <Shield size={12} />,    color: 'text-slate-600',  bg: 'bg-slate-50',  border: 'border-slate-200'  },
  oem:           { label: 'OEM',           icon: <Building2 size={12} />, color: 'text-teal-600',   bg: 'bg-teal-50',   border: 'border-teal-200'   },
  masters:       { label: 'Masters',       icon: <BookOpen size={12} />,  color: 'text-violet-600', bg: 'bg-violet-50', border: 'border-violet-200' },
  competitors:   { label: 'Competitors',   icon: <Swords size={12} />,    color: 'text-rose-600',   bg: 'bg-rose-50',   border: 'border-rose-200'   },
}

const MODULE_ORDER = [
  'customers', 'leads', 'opportunities', 'tenders', 'workorders',
  'travel', 'emdbg', 'oem', 'masters', 'competitors',
] as const

const SUGGESTIONS = [
  { label: 'Pending Leads',              query: 'pending leads' },
  { label: 'Lost Tenders',              query: 'lost tenders' },
  { label: 'Lost Tenders Last Month',   query: 'lost tenders last month' },
  { label: 'Lost Tenders This Month',   query: 'lost tenders this month' },
  { label: 'Lost Tenders This Year',    query: 'lost tenders this year' },
  { label: 'Submitted Tenders',         query: 'submitted tenders' },
  { label: 'Evaluation Tenders',        query: 'evaluation tenders' },
  { label: 'Won Opportunities',         query: 'won opportunities' },
  { label: 'Pending Opportunities',     query: 'pending opportunities' },
  { label: 'Active Work Orders',        query: 'active work orders' },
  { label: 'Completed Work Orders',     query: 'completed work orders' },
  { label: 'Active Customers',           query: 'active customers' },
  { label: 'Inactive Customers',         query: 'inactive customers' },
  { label: 'Pending Travel Requests',    query: 'pending travel' },
  { label: 'Approved Travel Requests',   query: 'approved travel' },
]

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
  highlight_field?: string
}

interface SmartMatch {
  label: string
  description: string
  module: string
}

interface SearchResults {
  customers:     { items: SearchItem[]; total: number | null }
  leads:         { items: SearchItem[]; total: number | null }
  opportunities: { items: SearchItem[]; total: number | null }
  tenders:       { items: SearchItem[]; total: number | null }
  workorders:    { items: SearchItem[]; total: number | null }
  travel?:       { items: SearchItem[]; total: number | null }
  emdbg?:        { items: SearchItem[]; total: number | null }
  oem?:          { items: SearchItem[]; total: number | null }
  masters?:      { items: SearchItem[]; total: number | null }
  competitors?:  { items: SearchItem[]; total: number | null }
  smart_match?:  SmartMatch
}

interface AiRecord {
  id: number
  url?: string
  [key: string]: any
}

interface AiAnswer {
  answer: string
  records: AiRecord[]
  tools_used: string[]
  mode: string
}

// A query "looks like" a natural-language question when it starts with a
// question word or contains a '?' — short keyword phrases stay on the fast path.
const QUESTION_STARTERS = [
  'who', 'what', 'which', 'when', 'where', 'why', 'how',
  'is', 'are', 'does', 'do', 'did', 'can', 'could', 'should', 'will',
  'show me', 'find', 'list', 'tell me',
]

function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (!t) return false
  if (t.includes('?')) return true
  if (QUESTION_STARTERS.some(w => t.startsWith(w + ' '))) return true
  return t.split(/\s+/).length >= 6
}

// Best-effort label for the primary field on an AI record (varies by module)
function aiRecordTitle(r: AiRecord): string {
  return r.customer_name || r.lead_title || r.title || r.tender_title
    || r.project_title || r.subject || r.wo_number || `Record #${r.id}`
}

function aiRecordSubtitle(r: AiRecord): string | null {
  const bits = [r.status || r.account_status || r.tender_status, r.assigned_to_name || r.owner_name || r.project_manager_name]
    .filter(Boolean)
  return bits.length ? bits.join(' · ') : null
}

// ─── Highlight helpers ────────────────────────────────────────────────────────

// Autocomplete: bold each suggestion word that starts with one of the typed words
function AutocompleteHighlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <span>{text}</span>
  const qWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  return (
    <span>
      {text.split(' ').map((word, i) => {
        const matched = qWords.some(qw => word.toLowerCase().startsWith(qw))
        return (
          <span key={i}>
            {i > 0 && ' '}
            {matched
              ? <span className="font-semibold text-indigo-700">{word}</span>
              : <span className="text-gray-600">{word}</span>
            }
          </span>
        )
      })}
    </span>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text) return <span>{text}</span>
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-yellow-200 text-yellow-900 rounded px-0.5 not-italic font-semibold">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </span>
  )
}

// ─── Recent searches ───────────────────────────────────────────────────────────

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { return [] }
}

function saveRecent(term: string) {
  const prev = loadRecent().filter(t => t.toLowerCase() !== term.toLowerCase())
  localStorage.setItem(RECENT_KEY, JSON.stringify([term, ...prev].slice(0, MAX_RECENT)))
}

function removeRecent(term: string) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(loadRecent().filter(t => t !== term)))
}

// ─── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return null
  const map: Record<string, string> = {
    Converted:  'bg-green-100 text-green-700',
    'Opportunity Created': 'bg-purple-100 text-purple-700',
    Assigned:   'bg-blue-100 text-blue-700',
    Qualified:  'bg-indigo-100 text-indigo-700',
    Lost:       'bg-red-100 text-red-600',
    Active:     'bg-green-100 text-green-700',
    Inactive:   'bg-gray-100 text-gray-500',
    Submitted:  'bg-blue-100 text-blue-700',
    Aligned:    'bg-amber-100 text-amber-700',
    Completed:  'bg-green-100 text-green-700',
    Draft:      'bg-gray-100 text-gray-500',
  }
  const cls = map[status] || 'bg-gray-100 text-gray-500'
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold ${cls}`}>
      {status}
    </span>
  )
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function GlobalSearch() {
  const navigate = useNavigate()
  const { label: customerLabel, labelLower: customerLabelLower } = useModuleName('customers')
  const { label: leadLabel, labelLower: leadLabelLower } = useModuleName('leads')
  const { label: opportunityLabel } = useModuleName('opportunities')
  const { label: tenderLabel, labelLower: tenderLabelLower } = useModuleName('tenders')
  const { label: workOrderLabel } = useModuleName('workorders')
  const { label: travelLabel, labelLower: travelLabelLower } = useModuleName('travel')
  const { label: emdbgLabel } = useModuleName('emdbg')
  const { label: oemLabel, labelLower: oemLabelLower } = useModuleName('oems')
  const { label: mastersLabel, labelLower: mastersLabelLower } = useModuleName('masters')
  const { label: competitorsLabel } = useModuleName('competitors')
  const moduleLabels: Record<string, string> = {
    customers: customerLabel,
    leads: leadLabel,
    opportunities: opportunityLabel,
    tenders: tenderLabel,
    workorders: workOrderLabel,
    travel: travelLabel,
    emdbg: emdbgLabel,
    oem: oemLabel,
    masters: mastersLabel,
    competitors: competitorsLabel,
  }

  const [open, setOpen]         = useState(false)
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<SearchResults | null>(null)
  const [loading, setLoading]   = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [recent, setRecent]     = useState<string[]>([])
  const [pulse, setPulse]       = useState(false)   // blink on new results

  const [aiEnabled, setAiEnabled]   = useState(false)
  const [tab, setTab]               = useState<'quick' | 'ai'>('quick')
  const [aiAnswer, setAiAnswer]     = useState<AiAnswer | null>(null)
  const [aiLoading, setAiLoading]   = useState(false)
  const [aiAskedFor, setAiAskedFor] = useState('')   // query the current aiAnswer belongs to

  const inputRef      = useRef<HTMLInputElement>(null)
  const containerRef  = useRef<HTMLDivElement>(null)
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aiDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const acSelectedRef = useRef(false)   // true when user clicked an autocomplete suggestion

  // Check once whether the backend has AI search configured (hides the tab otherwise)
  useEffect(() => {
    if (!SHOW_AI_SEARCH) {
      setAiEnabled(false)
      return
    }
    api.get('/search/ai-status').then(r => setAiEnabled(!!r.data?.enabled)).catch(() => setAiEnabled(false))
  }, [])

  // Flat list of all result items for keyboard navigation
  const flatItems: SearchItem[] = results
    ? MODULE_ORDER.flatMap(m => results[m]?.items ?? [])
    : []

  // ── Open/close ────────────────────────────────────────────────────────────

  const openSearch = () => {
    setOpen(true)
    setRecent(loadRecent())
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  const closeSearch = useCallback(() => {
    setOpen(false)
    setQuery('')
    setResults(null)
    setActiveIdx(-1)
    setTab('quick')
    setAiAnswer(null)
    setAiAskedFor('')
  }, [])

  // Close on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeSearch()
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [closeSearch])

  // Global Ctrl+K shortcut
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        if (open) closeSearch()
        else openSearch()
      }
      if (e.key === 'Escape' && open) closeSearch()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, closeSearch])

  // ── Search (debounced) ────────────────────────────────────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (!query.trim()) {
      setResults(null)
      setActiveIdx(-1)
      return
    }

    // Suppress keyword API when typing a partial smart pattern — show autocomplete instead.
    // Only skip suppression when the user explicitly selected a suggestion (acSelectedRef)
    // or typed the exact full query of a suggestion.
    const qWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const hasACMatch = SHOW_SMART_SEARCH && SUGGESTIONS.some(s => {
      const sWords = s.label.toLowerCase().split(' ')
      return qWords.every(qw => sWords.some(sw => sw.startsWith(qw)))
    })
    const isExactSuggestion = SHOW_SMART_SEARCH && SUGGESTIONS.some(
      s => s.query.toLowerCase() === query.toLowerCase().trim()
    )

    if (hasACMatch && !acSelectedRef.current && !isExactSuggestion) {
      setResults(null)
      setLoading(false)
      return
    }
    acSelectedRef.current = false   // consume the flag

    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await api.get(`/search?q=${encodeURIComponent(query.trim())}`)
        setResults(r.data)
        setActiveIdx(-1)
        setPulse(true)
        setTimeout(() => setPulse(false), 600)
      } catch {
        setResults(null)
      } finally {
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  // ── AI ask (debounced, only when AI mode is enabled + tab is active) ──────

  useEffect(() => {
    if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current)

    if (!SHOW_AI_SEARCH || !aiEnabled || !query.trim()) {
      setAiAnswer(null)
      setAiAskedFor('')
      return
    }

    // Auto-switch to the AI tab the moment the query reads like a real question
    if (looksLikeQuestion(query)) setTab('ai')

    if (tab !== 'ai') return

    aiDebounceRef.current = setTimeout(async () => {
      const asked = query.trim()
      setAiLoading(true)
      try {
        const r = await api.post('/search/ask', { query: asked })
        setAiAnswer(r.data)
        setAiAskedFor(asked)
      } catch {
        setAiAnswer({ answer: 'AI search failed — please try again.', records: [], tools_used: [], mode: 'ai' })
        setAiAskedFor(asked)
      } finally {
        setAiLoading(false)
      }
    }, 500)

    return () => { if (aiDebounceRef.current) clearTimeout(aiDebounceRef.current) }
  }, [query, tab, aiEnabled])

  // ── Navigation ────────────────────────────────────────────────────────────

  const goToItem = useCallback((item: SearchItem) => {
    saveRecent(query.trim())
    closeSearch()
    navigate(item.url)
  }, [query, navigate, closeSearch])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, flatItems.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIdx >= 0 && flatItems[activeIdx]) {
        goToItem(flatItems[activeIdx])
      } else {
        // When autocomplete is open, Enter selects the first suggestion
        const qWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
        const acMatch = SUGGESTIONS.find(s => {
          const sWords = s.label.toLowerCase().split(' ')
          return qWords.every(qw => sWords.some(sw => sw.startsWith(qw)))
        })
        if (acMatch && !results) {
          acSelectedRef.current = true
          setQuery(acMatch.query)
        }
      }
    } else if (e.key === 'Escape') {
      closeSearch()
    }
  }

  const handleRecentClick = (term: string) => {
    setQuery(term)
    inputRef.current?.focus()
  }

  const handleRemoveRecent = (e: React.MouseEvent, term: string) => {
    e.stopPropagation()
    removeRecent(term)
    setRecent(loadRecent())
  }

  // ── Total results count ───────────────────────────────────────────────────

  const totalCount = results
    ? MODULE_ORDER.reduce((s, m) => s + (results[m]?.items?.length ?? 0), 0)
    : 0

  const hasResults = totalCount > 0

  // ── Autocomplete: pattern hints while the user is typing ─────────────────
  const autocompleteSuggestions = SHOW_SMART_SEARCH && query.trim().length >= 1
    ? SUGGESTIONS.filter(s => {
        const qWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
        const sWords = s.label.toLowerCase().split(' ')
        return qWords.every(qw => sWords.some(sw => sw.startsWith(qw)))
      })
    : []
  const showAutocomplete = autocompleteSuggestions.length > 0 && !results

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div ref={containerRef} className="relative">
      {/* Search trigger button */}
      <button
        type="button"
        onClick={openSearch}
        className="p-2 rounded-xl transition-all"
        style={{ color: '#fff' }}
        aria-label="Search (Ctrl+K)"
        title="Search (Ctrl+K)"
        onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.14)'}
        onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
      >
        <Search size={18} />
      </button>

      {/* Search overlay */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-[2px] z-[200]"
          style={{ animation: 'fadeIn 0.15s ease' }}
          onClick={closeSearch}
        />
      )}

      {/* Search panel */}
      {open && (
        <div
          className="fixed left-1/2 z-[210] w-full max-w-2xl"
          style={{
            top: '72px',
            transform: 'translateX(-50%)',
            animation: 'slideDown 0.18s ease',
          }}
        >
          {/* Input bar */}
          <div className="mx-3 sm:mx-0 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100">
              <Search size={18} className="text-gray-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Search ${customerLabelLower}, ${leadLabelLower}, ${tenderLabelLower}, ${travelLabelLower}, ${oemLabelLower}, ${mastersLabelLower}...`}
                className="flex-1 text-sm text-gray-800 placeholder:text-gray-400 bg-transparent outline-none"
                autoComplete="off"
              />
              <div className="flex items-center gap-2 flex-shrink-0">
                {(loading || (SHOW_AI_SEARCH && tab === 'ai' && aiLoading)) && (
                  <div className="w-4 h-4 border-2 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
                )}
                  <button
  type="button"
  onClick={closeSearch}
  className="p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
  title="Close"
  aria-label="Close search"
>
  <X size={16} />
</button>
              </div>
            </div>

            {/* Mode tabs — Quick Results / AI Answer (only shown once a query is typed and AI is available) */}
            {SHOW_AI_SEARCH && aiEnabled && query.trim() && (
              <div className="flex items-center gap-1 px-3 pt-2.5 border-b border-gray-100">
                <button
                  onClick={() => setTab('quick')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-semibold transition-colors ${
                    tab === 'quick' ? 'bg-gray-100 text-gray-800' : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  <ListFilter size={12} /> Quick Results
                </button>
                <button
                  onClick={() => setTab('ai')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-semibold transition-colors ${
                    tab === 'ai' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  <Bot size={12} /> AI Answer
                </button>
              </div>
            )}

            {/* Dropdown body */}
            <div className="max-h-[70vh] overflow-y-auto">

              {/* ── AI Answer panel ─────────────────────────────────────── */}
              {SHOW_AI_SEARCH && aiEnabled && query.trim() && tab === 'ai' && (
                <div className="px-4 py-4">
                  {aiLoading && aiAskedFor !== query.trim() ? (
                    <div className="space-y-2.5 py-4">
                      <div className="h-3 bg-gray-100 rounded animate-pulse w-full" />
                      <div className="h-3 bg-gray-100 rounded animate-pulse w-5/6" />
                      <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
                    </div>
                  ) : aiAnswer ? (
                    <div className="space-y-3">
                      <div className="flex items-start gap-2.5 rounded-xl bg-indigo-50/70 border border-indigo-100 px-3.5 py-3">
                        <Bot size={16} className="text-indigo-500 flex-shrink-0 mt-0.5" />
                        <p className="text-sm text-gray-800 leading-relaxed">{aiAnswer.answer}</p>
                      </div>

                      {aiAnswer.records.length > 0 && (
                        <div className="space-y-0.5">
                          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1">
                            Source Records ({aiAnswer.records.length})
                          </p>
                          {aiAnswer.records.map((r, i) => (
                            <button
                              key={`${r.id}-${i}`}
                              onClick={() => {
                                if (r.url) { saveRecent(query.trim()); closeSearch(); navigate(r.url) }
                              }}
                              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-gray-50 text-left"
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-gray-800 truncate">{aiRecordTitle(r)}</div>
                                {aiRecordSubtitle(r) && (
                                  <div className="text-xs text-gray-500 truncate">{aiRecordSubtitle(r)}</div>
                                )}
                              </div>
                              {r.url && <ArrowUpRight size={12} className="text-gray-300 flex-shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center py-8 text-center px-6">
                      <Bot size={20} className="text-gray-300 mb-2" />
                      <p className="text-sm text-gray-500">Ask a question about your customers, tenders, leads...</p>
                    </div>
                  )}
                </div>
              )}

              {/* Recent searches — shown when input is empty */}
              {tab === 'quick' && !query && recent.length > 0 && (
                <div className="px-3 pt-3 pb-2">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1.5">
                    Recent Searches
                  </p>
                  <div className="space-y-0.5">
                    {recent.map(term => (
                      <button
                        key={term}
                        onClick={() => handleRecentClick(term)}
                        className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl hover:bg-gray-50 text-left group"
                      >
                        <Clock size={13} className="text-gray-400 flex-shrink-0" />
                        <span className="flex-1 text-sm text-gray-700 truncate">{term}</span>
                        <button
                          onClick={e => handleRemoveRecent(e, term)}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-300 hover:text-gray-500 transition-all"
                          title="Remove"
                        >
                          <X size={11} />
                        </button>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Empty state hint (only when no recent searches) */}
              {tab === 'quick' && !query && recent.length === 0 && (
                <div className="flex flex-col items-center pt-8 pb-3 text-center px-6">
                  <div className="w-10 h-10 rounded-2xl bg-gray-100 flex items-center justify-center mb-2">
                    <Search size={18} className="text-gray-300" />
                  </div>
                  <p className="text-sm font-semibold text-gray-600">Start typing to search</p>
                  <p className="text-[10px] text-gray-300 mt-2">
                    <kbd className="font-mono">Ctrl+K</kbd> · <kbd className="font-mono">↑↓</kbd> navigate · <kbd className="font-mono">Enter</kbd> open
                  </p>
                </div>
              )}

              {/* Smart suggestion chips — always shown when input is empty */}
              {/* {!query && (
                <div className="px-3 pt-2 pb-3">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1.5 flex items-center gap-1">
                    <Sparkles size={9} className="text-indigo-400" /> Smart Suggestions
                  </p>
                  <div className="flex flex-wrap gap-1.5 px-1">
                    {SUGGESTIONS.map(s => (
                      <button
                        key={s.query}
                        onClick={() => { acSelectedRef.current = true; setQuery(s.query); inputRef.current?.focus() }}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-indigo-200 bg-indigo-50 text-xs text-indigo-700 hover:bg-indigo-100 transition-colors"
                      >
                        <Sparkles size={9} className="text-indigo-400" />
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )} */}

              {/* Autocomplete — smart pattern hints as the user types */}
              {SHOW_SMART_SEARCH && tab === 'quick' && showAutocomplete && (
                <div className="py-1">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-5 pt-2 pb-1 flex items-center gap-1">
                    <Sparkles size={9} className="text-indigo-400" /> Smart Matches
                  </p>
                  {autocompleteSuggestions.map(s => (
                    <button
                      key={s.query}
                      onClick={() => { acSelectedRef.current = true; setQuery(s.query) }}
                      className="w-full flex items-center gap-3 px-4 py-2 hover:bg-indigo-50 text-left group transition-colors"
                    >
                      <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
                        <Sparkles size={12} className="text-indigo-500" />
                      </div>
                      <span className="flex-1 text-sm">
                        <AutocompleteHighlight text={s.label} query={query} />
                      </span>
                      <ArrowUpRight size={12} className="text-indigo-300 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}

              {/* No results */}
              {tab === 'quick' && query && !loading && results && !hasResults && (
                <div className="flex flex-col items-center py-10 text-center px-6">
                  <p className="text-sm font-semibold text-gray-600">No results for "{query}"</p>
                  <p className="text-xs text-gray-400 mt-1">Try a different search term</p>
                </div>
              )}

              {/* Searching skeleton — hidden when autocomplete is showing */}
              {tab === 'quick' && query && loading && !results && !showAutocomplete && (
                <div className="px-4 py-4 space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-lg bg-gray-100 animate-pulse flex-shrink-0" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 bg-gray-100 rounded animate-pulse w-40" />
                        <div className="h-2.5 bg-gray-100 rounded animate-pulse w-24" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Results grouped by module */}
              {tab === 'quick' && results && hasResults && (
                <div className={`transition-opacity duration-200 ${pulse ? 'opacity-60' : 'opacity-100'}`}>

                  {/* Smart search banner — shown only when a pattern matched */}
                  {SHOW_SMART_SEARCH && results.smart_match && (
                    <div className="flex items-center gap-2 px-4 py-2 bg-indigo-50 border-b border-indigo-100">
                      <Sparkles size={13} className="text-indigo-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-semibold text-indigo-700">{results.smart_match.label}</span>
                        {results.smart_match.description && (
                          <span className="text-xs text-indigo-400 ml-1.5">— {results.smart_match.description}</span>
                        )}
                      </div>
                      <button
                        onClick={() => { setQuery(''); setResults(null); inputRef.current?.focus() }}
                        className="flex-shrink-0 text-[10px] text-indigo-400 hover:text-indigo-700 font-medium transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  )}

                  {MODULE_ORDER.map(mod => {
                    const group = results[mod]
                    if (!group?.items?.length) return null
                    const baseMeta = MODULE_META[mod]
                    const meta = { ...baseMeta, label: moduleLabels[mod] || baseMeta.label }
                    let flatOffset = MODULE_ORDER.slice(0, MODULE_ORDER.indexOf(mod))
                      .reduce((s, m) => s + (results[m]?.items?.length ?? 0), 0)

                    return (
                      <div key={mod}>
                        {/* Module header */}
                        <div className="flex items-center px-4 pt-3 pb-1.5">
                          <div className={`flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider ${meta.color}`}>
                            <span className={`p-0.5 rounded ${meta.bg}`}>{meta.icon}</span>
                            {meta.label}
                            <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-gray-100 text-gray-500">
                              {group.items.length}
                            </span>
                          </div>
                        </div>

                        {/* Items */}
                        {group.items.map((item, idx) => {
                          const globalIdx = flatOffset + idx
                          const isActive = globalIdx === activeIdx
                          return (
                            <button
                              key={`${mod}-${item.id}`}
                              onClick={() => goToItem(item)}
                              onMouseEnter={() => setActiveIdx(globalIdx)}
                              className={`w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors ${
                                isActive ? 'bg-blue-50' : 'hover:bg-gray-50'
                              }`}
                            >
                              {/* Module icon pill */}
                              <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 ${meta.bg} ${meta.color}`}>
                                {meta.icon}
                              </div>

                              {/* Content */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-sm font-semibold text-gray-800 truncate">
                                    <Highlight text={item.title} query={query} />
                                  </span>
                                  {item.ref_id && (
                                    <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${meta.bg} ${meta.color} ${meta.border}`}>
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
                                    <span className="text-[10px] text-gray-400 flex-shrink-0">
                                      · {item.assigned_to_name}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Arrow on hover/active */}
                              <ArrowUpRight
                                size={13}
                                className={`flex-shrink-0 mt-1 transition-opacity ${
                                  isActive ? 'opacity-100 text-blue-500' : 'opacity-0 text-gray-300'
                                }`}
                              />
                            </button>
                          )
                        })}
                      </div>
                    )
                  })}

                  {/* Results count footer */}
                  <div className="border-t border-gray-100 px-4 py-2.5">
                    <p className="text-xs text-gray-400">
                      {totalCount} result{totalCount !== 1 ? 's' : ''} for "{query}"
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* CSS animations */}
      <style>{`
        @keyframes fadeIn   { from { opacity: 0 }              to { opacity: 1 } }
        @keyframes slideDown{ from { opacity:0;transform:translateX(-50%) translateY(-8px) }
                              to   { opacity:1;transform:translateX(-50%) translateY(0)   } }
      `}</style>
    </div>
  )
}
