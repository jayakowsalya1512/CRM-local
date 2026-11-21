// Lets a note be linked to a CRM record (backend already supports this — StickyNote.link_module/
// link_record_id, validated via notes_router.py's _link() -> calendar_service.resolve_related()
// — but no frontend anywhere ever set it). Reuses the existing global search endpoint
// (GET /search, same one Ctrl+K search calls) instead of building new search logic.
import { useEffect, useRef, useState } from 'react'
import { Link2, Search, X } from 'lucide-react'
import api from '@/services/api'

export type RecordLink = { module: string; id: number; label: string }

const MODULE_LABEL: Record<string, string> = {
  customers: 'Customer', leads: 'Lead', opportunities: 'Deal',
  tenders: 'Tender', workorders: 'Work Order', travel: 'Travel',
}
const SEARCHABLE_MODULES = Object.keys(MODULE_LABEL)

type SearchResult = { id: number; module: string; title: string }

export default function RecordLinkPicker({ value, onChange }: { value: RecordLink | null; onChange: (v: RecordLink | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(() => {
      setLoading(true)
      api.get(`/search?q=${encodeURIComponent(query.trim())}`).then(({ data }) => {
        const flat: SearchResult[] = []
        for (const mod of SEARCHABLE_MODULES) {
          const items = data?.[mod]?.items as SearchResult[] | undefined
          if (items) flat.push(...items.slice(0, 5))
        }
        setResults(flat)
      }).catch(() => setResults([])).finally(() => setLoading(false))
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query])

  if (value) {
    return (
      <div className="flex items-center gap-1.5" style={{ fontSize: 12, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-2)', width: 'fit-content' }}>
        <Link2 size={12} />
        <span style={{ color: 'var(--text-muted)' }}>{MODULE_LABEL[value.module] || value.module}</span>
        <b>{value.label}</b>
        <button type="button" onClick={() => onChange(null)} style={{ border: 0, background: 'none', cursor: 'pointer', display: 'flex' }}><X size={12} /></button>
      </div>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {!open ? (
        <button type="button" className="tn-link" onClick={() => setOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Link2 size={12} /> Link to a record
        </button>
      ) : (
        <>
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              autoFocus
              className="form-control"
              style={{ height: 30, fontSize: 12, paddingLeft: 24 }}
              placeholder="Search customers, leads, tenders…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {(loading || results.length > 0 || query.trim().length >= 2) && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 20,
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
              boxShadow: 'var(--shadow-md)', maxHeight: 160, overflowY: 'auto',
            }}>
              {loading && <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>Searching…</div>}
              {!loading && results.length === 0 && query.trim().length >= 2 && (
                <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-muted)' }}>No matches</div>
              )}
              {!loading && results.map((r) => (
                <button
                  key={`${r.module}-${r.id}`}
                  type="button"
                  onClick={() => { onChange({ module: r.module, id: r.id, label: r.title }); setOpen(false); setQuery('') }}
                  style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 6, padding: '7px 10px', border: 0, background: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 12 }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  <span style={{ color: 'var(--text-muted)', flex: 'none' }}>{MODULE_LABEL[r.module] || r.module}</span>
                  <span>{r.title}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
