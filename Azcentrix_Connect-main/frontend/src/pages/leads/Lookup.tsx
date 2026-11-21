// Searchable master lookup (looks like the prototype's .in select). Options always come from a Masters API:
// `items` null = loading, `error` = load failed (with Retry), [] = empty. `onSearch` switches to server-side search.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Opt } from './leadApi'

export default function Lookup({ id, value, label, items, error, onChange, onSearch, onRetry, placeholder = 'Select…', emptyText = 'No matches', disabled, disabledText, bad, clearable = true, inputRef, onBlur }: {
  id: string; value: number | null; label?: string | null; items: Opt[] | null; error?: string; onChange: (o: Opt | null) => void
  onSearch?: (q: string) => void; onRetry?: () => void; placeholder?: string; emptyText?: string; disabled?: boolean; disabledText?: string; bad?: boolean; clearable?: boolean
  inputRef?: (el: HTMLElement | null) => void
  /** Called when the user leaves the lookup (tabs away, or closes the list) – used for field validation. */
  onBlur?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const qRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', off)
    setTimeout(() => qRef.current?.focus(), 0)
    return () => document.removeEventListener('mousedown', off)
  }, [open])
  // closing the list counts as leaving the field (runs after the picked value has been applied)
  useEffect(() => { if (wasOpen.current && !open) onBlur?.(); wasOpen.current = open }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!onSearch || !open) return; const t = setTimeout(() => onSearch(q), 220); return () => clearTimeout(t) }, [q, open]) // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const all = items || []
    if (onSearch || !q.trim()) return all.slice(0, 200)
    const ql = q.trim().toLowerCase()
    return all.filter(o => o.name.toLowerCase().includes(ql) || (o.sub || '').toLowerCase().includes(ql)).slice(0, 200)
  }, [items, q, onSearch])
  useEffect(() => { setHi(0) }, [q, items])
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('.lk-o.on')?.scrollIntoView({ block: 'nearest' }) }, [hi])

  const selected = value != null ? (items || []).find(o => o.id === value) : undefined
  const text = selected?.name ?? (value != null ? label || '' : '')
  const pick = (o: Opt | null) => { onChange(o); setOpen(false); setQ('') }

  return <div className="lk" ref={box}>
    <div id={id} ref={inputRef} role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      className={`in lk-in ${text ? '' : 'ph'} ${bad ? 'err' : ''}`} title={text || undefined} aria-invalid={bad || undefined}
      onBlur={e => { if (!open && !box.current?.contains(e.relatedTarget as Node | null)) onBlur?.() }}
      onClick={() => { if (!disabled) setOpen(o => !o) }}
      onKeyDown={e => { if (disabled) return; if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } else if ((e.key === 'Backspace' || e.key === 'Delete') && clearable && value != null) pick(null) }}>
      {disabled && disabledText ? disabledText : text || placeholder}
    </div>
    {open && <div className="lk-pop" role="listbox">
      <input ref={qRef} className="in lk-q" placeholder="Search…" value={q} aria-label="Search" onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, shown.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (shown[hi]) pick(shown[hi]) }
        }} />
      <div className="lk-l" ref={listRef}>
        {error ? <div className="lk-s bad">{error}{onRetry && <> · <a onClick={onRetry}>Retry</a></>}</div>
          : items === null ? <div className="lk-s">Loading…</div>
            : !shown.length ? <div className="lk-s">{q ? 'No matches' : emptyText}</div>
              : <>
                {clearable && value != null && !q && <div className="lk-o" onMouseDown={e => { e.preventDefault(); pick(null) }}><span className="mu">— Clear —</span></div>}
                {shown.map((o, i) => <div key={o.id} role="option" aria-selected={o.id === value} className={`lk-o ${i === hi ? 'on' : ''} ${o.id === value ? 'sel' : ''}`}
                  onMouseEnter={() => setHi(i)} onMouseDown={e => { e.preventDefault(); pick(o) }}>{o.name}{o.sub && <small>{o.sub}</small>}</div>)}
              </>}
      </div>
    </div>}
  </div>
}
