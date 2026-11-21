import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { BarChart3, CalendarDays, Columns3, Download, Filter, LayoutGrid, Menu, MoreHorizontal, Search, Star, Table2, X } from 'lucide-react'
import { Btn, BwModal, C, Field, inputCls, inputStyle, inr, num } from './bw'

// React port of the prototype's gridHTML(): toolbar, views, filters, grouping, saved views,
// column chooser, density, export, chips, bulk bar, multi-sort, resizable columns, sum footer, pager.

export type GridCol<R> = {
  k: string
  t: string
  w?: number
  r?: boolean
  sum?: boolean
  money?: boolean
  date?: boolean
  fn?: (r: R) => ReactNode
  txt?: (r: R) => string
  sv?: (r: R) => number | string | null
  sumv?: (r: R) => number
  sumFmt?: (n: number) => string
  /** Hidden until switched on in Columns. */
  hide?: boolean
  /** Not offered as a chart "Group by" dimension (prototype gchart skips the ID column). */
  nogroup?: boolean
  /** Inline editing (prototype ``ed``): double-click the cell, Enter or leaving the field saves, Escape cancels. */
  ed?: { t: 'num' | 'text' | 'sel' | 'date'; value: (r: R) => string; save: (r: R, value: string) => Promise<unknown> | unknown; min?: number; max?: number; step?: number
    /** Options for t: 'sel' (prototype ed {t:'sel', o:[…]}): choosing one saves immediately. */
    o?: string[] }
}
/** Server-side lists: rows are already the current page; paging, sorting and the advanced filter are done by the server. */
export type GridServer = { total: number; onChange: (s: { offset: number; limit: number; sorts: [string, number][]; adv: { logic: 'AND' | 'OR'; conds: { k: string; op: string; v: string }[] } }) => void
  /** Opt-in: while the chart or calendar view is open, ask the server for up to this many records (offset 0) so the
   *  chart summarises every matching record instead of the current page (prototype gchart works on the whole list). */
  chartLimit?: number }
export type GridBulk<R> = [string, (rows: R[]) => void]
/** Row actions menu (prototype menuBtn / gmenu): a trailing ⋯ column; return no items to hide the button on that row. */
export type GridMenuItem = { l: string; i?: ReactNode; fn: () => void; danger?: boolean }
type View = 'table' | 'cards' | 'chart' | 'calendar'
type Cond = { k: string; op: string; v: string }
type Saved = { id: string; n: string; def?: boolean; state: Persisted }
type Persisted = { hide: string[]; sorts: [string, number][]; f: Record<string, string>; grp: string; q: string; adv: { logic: 'AND' | 'OR'; conds: Cond[] }; vw: View }

const OPS: [string, string][] = [['contains', 'contains'], ['ncontains', 'does not contain'], ['eq', 'equals'], ['ne', 'not equal to'], ['starts', 'starts with'], ['gt', 'greater than'], ['lt', 'less than'], ['gte', 'at least'], ['lte', 'at most'], ['before', 'is before'], ['after', 'is after'], ['empty', 'is empty'], ['nempty', 'is not empty']]
const EXF = { CSV: 'csv', TSV: 'tsv', JSON: 'json', Markdown: 'md', HTML: 'html', 'Excel (.xls)': 'xls' } as const
const DENS = { cmp: ['Compact', 27], reg: ['Standard', 33], cozy: ['Comfortable', 44] } as const
type Den = keyof typeof DENS
const VIEWS: [View, ReactNode, string][] = [['table', <Table2 key="t" size={13} />, 'Table'], ['cards', <LayoutGrid key="c" size={13} />, 'Cards'], ['chart', <BarChart3 key="h" size={13} />, 'Chart'], ['calendar', <CalendarDays key="a" size={13} />, 'Calendar']]

function Pop({ anchor, minWidth, children }: { anchor: RefObject<HTMLElement>; minWidth: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect(), pw = box.current?.offsetWidth ?? minWidth
      if (r) setPos({ top: r.bottom + 3, left: Math.max(6, Math.min(r.left, window.innerWidth - pw - 6)) })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [anchor, minWidth])
  const host = (anchor.current?.closest('.platform-shell, .crm-shell') as HTMLElement | null) ?? document.body
  return createPortal(<div ref={box} data-bw-pop className="bw-pop" style={{ minWidth, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}>{children}</div>, host)
}

// prototype PAL (chart series colours)
const CHART_PAL = ['#2F6FD6', '#14A3A0', '#E8912D', '#8A5CF6', '#E5484D', '#1FA67A', '#64748B']
const load = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback } catch { return fallback } }
const save = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* ignore */ } }

export default function BwGrid<R>({ id, cols, rows, rid, onRow, bulk = [], tools, empty = 'No records match the current filters.', initialQuery = '', onQuery, server, menu, chart: chartOpt, canExport = true }: {
  /** Hide Export / Export selected when the user's role has no export permission (default: shown). */
  canExport?: boolean
  id: string; cols: GridCol<R>[]; rows: R[]; rid: (r: R) => string; onRow?: (r: R) => void; bulk?: GridBulk<R>[]; tools?: ReactNode; empty?: string; initialQuery?: string
  /** Opt-in chart options (prototype gchart): default Group by column and the donut + legend beside the bars. */
  chart?: { by?: string; donut?: boolean }
  menu?: (r: R) => GridMenuItem[]
  /** Server-side lists: called with the search box and quick-filter values so the server can filter (rows are still filtered locally too). */
  onQuery?: (s: { q: string; f: Record<string, string> }) => void
  server?: GridServer
}) {
  const savedKey = `bw-grid-views:${id}`
  const [saved, setSaved] = useState<Saved[]>(() => load(savedKey, []))
  const def = saved.find(v => v.def)
  const [hide, setHide] = useState<Set<string>>(new Set(def?.state.hide ?? cols.filter(c => c.hide).map(c => c.k)))
  const [w, setW] = useState<Record<string, number>>(() => load(`bw-grid-w:${id}`, {}))
  const [sorts, setSorts] = useState<[string, number][]>(def?.state.sorts || [])
  const [f, setF] = useState<Record<string, string>>(def?.state.f || {})
  const [fr, setFr] = useState(false)
  const [grp, setGrp] = useState(def?.state.grp || '')
  const [den, setDen] = useState<Den>(() => load(`bw-grid-den:${id}`, 'cmp'))
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(25)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [q, setQ] = useState(initialQuery || def?.state.q || '')
  const [coll, setColl] = useState<Set<string>>(new Set())
  const [vw, setVw] = useState<View>(def?.state.vw || 'table')
  const [adv, setAdv] = useState<{ logic: 'AND' | 'OR'; conds: Cond[] }>(def?.state.adv || { logic: 'AND', conds: [] })
  const [cur, setCur] = useState<string | null>(def?.n ?? null)
  const [pop, setPop] = useState<'views' | 'cols' | 'row' | null>(null)
  const [menuRow, setMenuRow] = useState<R | null>(null)
  const menuBtn = useRef<HTMLElement | null>(null)
  const [editing, setEditing] = useState<{ row: string; col: string; v: string; busy: boolean } | null>(null)
  const viewsBtn = useRef<HTMLSpanElement>(null)
  const colsBtn = useRef<HTMLSpanElement>(null)
  const [advDraft, setAdvDraft] = useState<{ logic: 'AND' | 'OR'; conds: Cond[] } | null>(null)
  const [exp, setExp] = useState<{ fmt: keyof typeof EXF; scope: 'flt' | 'all' | 'sel'; hdr: boolean; cols: string[] } | null>(null)
  const [cby, setCby] = useState('')
  const [cmeas, setCmeas] = useState('count')
  const [cm, setCm] = useState(0)
  const [ccol, setCcol] = useState('')
  useEffect(() => { if (initialQuery) setQ(initialQuery) }, [initialQuery])
  useEffect(() => { onQuery?.({ q, f }) }, [q, f, onQuery])
  useEffect(() => save(`bw-grid-w:${id}`, w), [id, w])
  useEffect(() => save(`bw-grid-den:${id}`, den), [id, den])
  useEffect(() => save(savedKey, saved), [savedKey, saved])
  useEffect(() => { const valid = new Set(rows.map(rid)); setSel(s => new Set([...s].filter(k => valid.has(k)))) }, [rows, rid])

  const vis = cols.filter(c => !hide.has(c.k))
  const txt = (c: GridCol<R>, r: R) => c.txt ? c.txt(r) : String((r as Record<string, unknown>)[c.k] ?? '')
  const val = (c: GridCol<R>, r: R) => c.sv ? c.sv(r) : ((r as Record<string, unknown>)[c.k] as number | string | null) ?? txt(c, r)
  const width = (c: GridCol<R>) => w[c.k] || c.w || (c.money ? 112 : c.date ? 122 : c.r ? 100 : 158)
  const fmt = (c: GridCol<R>, v: number) => c.sumFmt ? c.sumFmt(v) : c.money ? inr(v) : num(v)
  const sumOf = (c: GridCol<R>, rs: R[]) => rs.reduce((a, r) => a + (Number(c.sumv ? c.sumv(r) : val(c, r)) || 0), 0)
  const advOk = (r: R, cd: Cond) => {
    const c = cols.find(x => x.k === cd.k); if (!c) return true
    const t = txt(c, r), tl = t.toLowerCase(), v = cd.v.toLowerCase(), rv = val(c, r)
    const nv = typeof rv === 'number' ? rv : parseFloat(t.replace(/[^0-9.-]/g, '')), vn = parseFloat(cd.v)
    switch (cd.op) {
      case 'contains': return tl.includes(v); case 'ncontains': return !tl.includes(v)
      case 'eq': return tl === v || (!isNaN(nv) && !isNaN(vn) && nv === vn); case 'ne': return !(tl === v || (!isNaN(nv) && !isNaN(vn) && nv === vn))
      case 'starts': return tl.startsWith(v); case 'gt': return nv > vn; case 'lt': return nv < vn; case 'gte': return nv >= vn; case 'lte': return nv <= vn
      case 'empty': return tl === '' || tl === '—'; case 'nempty': return tl !== '' && tl !== '—'
      case 'before': return String(rv) < cd.v; case 'after': return String(rv) > cd.v
    }
    return true
  }
  const all = useMemo(() => {
    if (server) return rows
    let r = rows
    if (q) { const s = q.toLowerCase(); r = r.filter(x => cols.some(c => txt(c, x).toLowerCase().includes(s))) }
    for (const k in f) { const v = (f[k] || '').toLowerCase(); const c = cols.find(c => c.k === k); if (v && c) r = r.filter(x => txt(c, x).toLowerCase().includes(v)) }
    const cd = adv.conds.filter(c => c.k)
    if (cd.length) r = r.filter(x => adv.logic === 'AND' ? cd.every(c => advOk(x, c)) : cd.some(c => advOk(x, c)))
    const so: [string, number][] = grp ? [[grp, 1], ...sorts] : sorts
    if (so.length) r = r.slice().sort((a, b) => {
      for (const [k, d] of so) {
        const c = cols.find(c => c.k === k); if (!c) continue
        const x = val(c, a), y = val(c, b)
        const z = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true })
        if (z) return z * d
      }
      return 0
    })
    return r
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, f, adv, sorts, grp, cols])
  const total = server ? server.total : all.length, pages = Math.max(1, Math.ceil(total / size)), pg = Math.min(page, pages)
  const flat = !!grp || vw === 'chart' || vw === 'calendar'
  const shown = server || flat ? all : all.slice((pg - 1) * size, pg * size)
  const allRows = !!server?.chartLimit && (vw === 'chart' || vw === 'calendar')
  const serverKey = JSON.stringify([pg, size, sorts, adv, allRows])
  useEffect(() => { server?.onChange(allRows ? { offset: 0, limit: server.chartLimit!, sorts, adv } : { offset: (pg - 1) * size, limit: size, sorts, adv }) }, [serverKey])  // eslint-disable-line react-hooks/exhaustive-deps
  const selected = rows.filter(r => sel.has(rid(r)))
  const toggle = (k: string) => setSel(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const allOnPage = shown.length > 0 && shown.every(r => sel.has(rid(r)))
  const sortBy = (k: string, shift: boolean) => {
    const i = sorts.findIndex(x => x[0] === k)
    if (shift) { const n = sorts.slice(); if (i < 0) n.push([k, 1]); else if (n[i][1] > 0) n[i] = [k, -1]; else n.splice(i, 1); setSorts(n) }
    else { const dir = i >= 0 && sorts.length === 1 ? (sorts[i][1] > 0 ? -1 : 0) : 1; setSorts(dir ? [[k, dir]] : []) }
  }
  const state = (): Persisted => ({ hide: [...hide], sorts, f, grp, q, adv, vw })
  const apply = (s: Saved | null) => {
    const p = s?.state; setHide(new Set(p?.hide)); setSorts(p?.sorts || []); setF(p?.f || {}); setGrp(p?.grp || ''); setQ(p?.q || ''); setAdv(p?.adv || { logic: 'AND', conds: [] }); setVw(p?.vw || 'table'); setCur(s?.n ?? null); setPage(1); setPop(null)
  }
  const saveView = () => { const n = window.prompt('Name this view'); if (!n?.trim()) return; setSaved(v => [...v.filter(x => x.n !== n.trim()), { id: String(Date.now()), n: n.trim(), state: state() }]); setCur(n.trim()); setPop(null) }
  const colTitle = (k: string) => cols.find(c => c.k === k)?.t || k
  const chips: [string, string][] = []
  if (q) chips.push(['q', `Search: “${q}”`])
  Object.entries(f).forEach(([k, v]) => v && chips.push([`f:${k}`, `${colTitle(k)} contains “${v}”`]))
  adv.conds.forEach((c, i) => c.k && chips.push([`a:${i}`, `${colTitle(c.k)} ${OPS.find(o => o[0] === c.op)?.[1] || c.op}${['empty', 'nempty'].includes(c.op) ? '' : ` “${c.v}”`}`]))
  const dropChip = (k: string) => {
    if (k === 'q') setQ('')
    else if (k.startsWith('f:')) setF(x => ({ ...x, [k.slice(2)]: '' }))
    else { const i = Number(k.slice(2)); setAdv(a => ({ ...a, conds: a.conds.filter((_, j) => j !== i) })) }
  }
  const clearAll = () => { setQ(''); setF({}); setAdv({ logic: 'AND', conds: [] }); setPage(1) }
  const groupable = cols.filter(c => !c.r && !c.date && c.k !== 'health')

  // close popovers on outside click (prototype closePop)
  useEffect(() => {
    if (!pop) return
    const close = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest('[data-bw-pop]')) setPop(null) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [pop])

  // column resize
  const drag = useRef<{ k: string; x: number; w: number } | null>(null)
  useEffect(() => {
    const move = (e: MouseEvent) => { const d = drag.current; if (d) setW(x => ({ ...x, [d.k]: Math.max(60, d.w + e.clientX - d.x) })) }
    const up = () => { drag.current = null }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [])

  const cellCls = (c: GridCol<R>, i: number) => `${c.r ? 'r' : ''} ${i === 0 ? 'pin' : ''}`
  const rowEl = (r: R) => {
    const k = rid(r), s = sel.has(k)
    return <tr key={k} className={`${s ? 'sel' : ''} ${onRow ? 'clk' : ''}`} onClick={() => onRow?.(r)}>
      <td className="ck" onClick={e => e.stopPropagation()}><input type="checkbox" checked={s} onChange={() => toggle(k)} aria-label="Select row" /></td>
      {vis.map((c, i) => {
        const ed = c.ed, on = ed && editing?.row === k && editing.col === c.k
        if (!ed) return <td key={c.k} className={cellCls(c, i)}>{c.fn ? c.fn(r) : txt(c, r)}</td>
        const commit = async () => {
          if (!editing || editing.busy) return
          if (editing.v === ed.value(r)) { setEditing(null); return }
          setEditing({ ...editing, busy: true })
          try { await ed.save(r, editing.v); setEditing(null) } catch { setEditing(x => x && { ...x, busy: false }) }
        }
        return <td key={c.k} className={cellCls(c, i)} title={on ? undefined : 'Double-click to edit'} onClick={e => e.stopPropagation()}
          onDoubleClick={e => { e.stopPropagation(); setEditing({ row: k, col: c.k, v: ed.value(r), busy: false }) }}>
          {on && ed.t === 'sel' ? <select autoFocus className={`${inputCls} !h-[22px] text-xs`} style={inputStyle} value={editing!.v} disabled={editing!.busy} aria-label={`Edit ${c.t}`}
            onChange={async e => { const v = e.target.value; if (v === ed.value(r)) { setEditing(null); return } setEditing(x => x && { ...x, v, busy: true }); try { await ed.save(r, v); setEditing(null) } catch { setEditing(x => x && { ...x, busy: false }) } }}
            onBlur={() => setEditing(x => (x && !x.busy ? null : x))} onKeyDown={e => { if (e.key === 'Escape') setEditing(null) }}>
            {(ed.o || []).map(o => <option key={o}>{o}</option>)}</select>
            : on ? <input autoFocus className={`${inputCls} !h-[22px] text-xs ${c.r ? 'text-right' : ''}`} style={inputStyle} type={ed.t === 'num' ? 'number' : ed.t === 'date' ? 'date' : 'text'}
            min={ed.min} max={ed.max} step={ed.step} value={editing!.v} disabled={editing!.busy} aria-label={`Edit ${c.t}`}
            onChange={e => setEditing(x => x && { ...x, v: e.target.value })} onBlur={() => void commit()}
            onKeyDown={e => { if (e.key === 'Enter') void commit(); else if (e.key === 'Escape') setEditing(null) }} />
            : c.fn ? c.fn(r) : txt(c, r)}
        </td>
      })}
      {menu && <td className="ra" onClick={e => e.stopPropagation()}>{menu(r).length > 0 && <span data-bw-pop>
        <button type="button" className="bw-rowmenu" aria-label="Row actions" aria-haspopup="menu" aria-expanded={pop === 'row' && menuRow === r}
          onClick={e => { menuBtn.current = e.currentTarget; setMenuRow(r); setPop(p => p === 'row' && menuRow === r ? null : 'row') }}>
          <MoreHorizontal size={14} /></button></span>}</td>}
    </tr>
  }
  const tableBody = () => {
    if (!total) return <tr><td colSpan={vis.length + 1 + (menu ? 1 : 0)} className="empty">{empty} <button type="button" onClick={clearAll} style={{ color: C.ac }}>Clear all filters</button></td></tr>
    if (!grp) return shown.map(rowEl)
    const gc = cols.find(c => c.k === grp)!, m = new Map<string, R[]>()
    all.forEach(r => { const k = txt(gc, r) || '—'; m.set(k, [...(m.get(k) || []), r]) })
    return [...m.entries()].flatMap(([g, rs]) => [
      <tr key={`g-${g}`} className="gg" onClick={() => setColl(s => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n })}>
        <td colSpan={vis.length + 1 + (menu ? 1 : 0)}>{coll.has(g) ? '▸' : '▾'} {g} <small className="font-normal" style={{ color: C.mu }}>{rs.length} records{vis.filter(c => c.sum).map(c => ` · ${c.t}: ${fmt(c, sumOf(c, rs))}`).join('')}</small></td>
      </tr>,
      ...(coll.has(g) ? [] : rs.map(rowEl)),
    ])
  }
  const exportText = (e: NonNullable<typeof exp>) => {
    const src = e.scope === 'sel' ? selected : e.scope === 'all' ? rows : all
    const cs = cols.filter(c => e.cols.includes(c.k))
    const data = src.map(r => cs.map(c => txt(c, r)))
    const head = cs.map(c => c.t)
    const esc = (s: string, d: string) => /["\n\r]/.test(s) || s.includes(d) ? `"${s.replace(/"/g, '""')}"` : s
    const h = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    let text = ''
    if (e.fmt === 'JSON') text = JSON.stringify(data.map(r => Object.fromEntries(r.map((v, i) => [head[i], v]))), null, 2)
    else if (e.fmt === 'Markdown') text = [...(e.hdr ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`] : []), ...data.map(r => `| ${r.map(v => v.replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n')
    else if (e.fmt === 'HTML' || e.fmt === 'Excel (.xls)') text = `<table>${e.hdr ? `<tr>${head.map(x => `<th>${h(x)}</th>`).join('')}</tr>` : ''}${data.map(r => `<tr>${r.map(v => `<td>${h(v)}</td>`).join('')}</tr>`).join('')}</table>`
    else { const d = e.fmt === 'TSV' ? '\t' : ','; text = [...(e.hdr ? [head] : []), ...data].map(r => r.map(v => esc(v, d)).join(d)).join('\n') }
    return { text, n: data.length }
  }
  const download = () => {
    if (!exp) return
    const { text } = exportText(exp), ext = EXF[exp.fmt]
    const type = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', md: 'text/markdown', html: 'text/html', xls: 'application/vnd.ms-excel' }[ext]
    const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = `${id}-${new Date().toISOString().slice(0, 10)}.${ext}`; a.click(); URL.revokeObjectURL(url)
    setExp(null)
  }

  const chart = () => {
    const dims = groupable.filter(c => !c.nogroup), meas = cols.filter(c => c.sum)
    const by = dims.find(c => c.k === cby) || dims.find(c => c.k === chartOpt?.by) || dims[0], ms = meas.find(c => c.k === cmeas)
    if (!by) return <div className="p-4 text-center text-xs" style={{ color: C.mu }}>No groupable columns</div>
    const m = new Map<string, { n: number; v: number }>()
    all.forEach(r => { const k = txt(by, r) || '—', o = m.get(k) || { n: 0, v: 0 }; o.n++; if (ms) o.v += Number(ms.sumv ? ms.sumv(r) : val(ms, r)) || 0; m.set(k, o) })
    const data = [...m.entries()].map(([l, o]) => ({ l, v: ms ? o.v : o.n })).sort((a, b) => b.v - a.v).slice(0, 12), max = Math.max(1, ...data.map(d => d.v))
    return <div className="p-2.5"><div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
      <label className="flex items-center gap-1.5">Group by <select className={`${inputCls} !h-6 !w-[150px] text-xs`} style={inputStyle} value={by.k} onChange={e => setCby(e.target.value)}>{dims.map(c => <option key={c.k} value={c.k}>{c.t}</option>)}</select></label>
      <label className="flex items-center gap-1.5">Measure <select className={`${inputCls} !h-6 !w-[150px] text-xs`} style={inputStyle} value={ms?.k || 'count'} onChange={e => setCmeas(e.target.value)}><option value="count">Record count</option>{meas.map(c => <option key={c.k} value={c.k}>Sum of {c.t}</option>)}</select></label>
      {chartOpt?.donut ? <small style={{ color: C.mu }}>{total} records · {m.size} groups</small> : <><span className="flex-1" /><small style={{ color: C.mu }}>{total} records · {m.size} groups</small></>}
    </div>{(() => {
      const bars = <div className="space-y-1.5">{data.map(d => <div key={d.l} className="flex items-center gap-2"><span className="w-[140px] truncate text-xs" title={d.l}>{d.l}</span><div className="h-2 flex-1 rounded-sm" style={{ background: C.ln2 }}><div className="h-full rounded-sm" style={{ width: `${d.v / max * 100}%`, background: chartOpt?.donut ? `linear-gradient(90deg,color-mix(in srgb,${C.ac} 70%,#fff),${C.ac})` : C.ac }} /></div><b className="w-[70px] text-right text-xs">{ms ? fmt(ms, d.v) : d.v}</b></div>)}</div>
      if (!chartOpt?.donut) return bars
      // prototype gchart: bars on the left, a donut of the top seven groups (overall total in the centre) and its legend
      const top = data.slice(0, 7), tt = top.reduce((a, d) => a + d.v, 0) || 1, all_ = [...m.values()].reduce((a, o) => a + (ms ? o.v : o.n), 0)
      const R0 = 40, SW = 13, CIR = 2 * Math.PI * R0
      let acc = 0
      return <div className="grid items-start gap-4" style={{ gridTemplateColumns: 'minmax(0,1.3fr) minmax(0,1fr)' }}>{bars}
        <div className="flex items-start gap-4"><svg viewBox="0 0 100 100" width={104} height={104} style={{ flex: 'none' }} role="img" aria-label="Share by group">
          <circle cx={50} cy={50} r={R0} fill="none" stroke={C.ln2} strokeWidth={SW} />
          {top.map((d, i) => { const len = d.v / tt * CIR, el = <circle key={d.l} cx={50} cy={50} r={R0} fill="none" stroke={CHART_PAL[i % CHART_PAL.length]} strokeWidth={SW}
            strokeDasharray={`${Math.max(0, len - 1.2)} ${CIR}`} strokeDashoffset={-acc} transform="rotate(-90 50 50)"><title>{d.l}: {ms ? fmt(ms, d.v) : d.v}</title></circle>; acc += len; return el })}
          <text x={50} y={54} textAnchor="middle" fontSize={ms ? 11 : 15} fontWeight={700} fill={C.tx}>{ms ? fmt(ms, all_) : all_}</text></svg>
          <div className="min-w-0 flex-1 space-y-1">{top.map((d, i) => <div key={d.l} className="flex items-center gap-2 text-xs"><i className="inline-block h-2.5 w-2.5 flex-none rounded-sm" style={{ background: CHART_PAL[i % CHART_PAL.length] }} />
            <span className="min-w-0 flex-1 truncate" title={d.l}>{d.l}</span><b className="flex-none">{ms ? fmt(ms, d.v) : d.v}</b><small className="w-9 flex-none text-right" style={{ color: C.mu }}>{Math.round(d.v / tt * 100)}%</small></div>)}</div></div></div>
    })()}</div>
  }
  const calendar = () => {
    const dc = cols.filter(c => c.date)
    if (!dc.length) return <div className="p-4 text-center text-xs" style={{ color: C.mu }}>This list has no date column to plot.</div>
    const col = dc.find(c => c.k === ccol) || dc[0], t0 = vis[0] || cols[0]
    const today = new Date(), base = new Date(today.getFullYear(), today.getMonth() + cm, 1), off = (base.getDay() + 6) % 7
    const first = new Date(base); first.setDate(1 - off)
    const ev: Record<string, R[]> = {}
    all.forEach(r => { const d = String(val(col, r) || '').slice(0, 10); if (d) (ev[d] ??= []).push(r) })
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return <div className="p-2.5"><div className="mb-2 flex items-center gap-2">
      <Btn s onClick={() => setCm(m => m - 1)}>‹</Btn><b className="w-[140px] text-center">{base.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</b><Btn s onClick={() => setCm(m => m + 1)}>›</Btn><span className="flex-1" />
      <label className="flex items-center gap-1.5 text-xs">Plot by <select className={`${inputCls} !h-6 !w-[160px] text-xs`} style={inputStyle} value={col.k} onChange={e => setCcol(e.target.value)}>{dc.map(c => <option key={c.k} value={c.k}>{c.t}</option>)}</select></label>
    </div><div className="grid grid-cols-7 gap-px rounded-md border" style={{ background: C.ln2, borderColor: C.ln }}>
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="px-1.5 py-1 text-[11px] font-semibold" style={{ background: C.hd, color: C.mu }}>{d}</div>)}
      {Array.from({ length: 42 }, (_, i) => { const d = new Date(first); d.setDate(first.getDate() + i); const k = key(d), L = ev[k] || []; return <div key={k} className="min-h-[64px] p-1 text-[11px]" style={{ background: C.sf, opacity: d.getMonth() !== base.getMonth() ? 0.5 : 1, outline: k === key(today) ? `1px solid ${C.ac}` : undefined }}>
        <b>{d.getDate()}</b>{L.slice(0, 3).map(r => <span key={rid(r)} onClick={() => onRow?.(r)} title={txt(t0, r)} className="mt-0.5 block cursor-pointer truncate rounded-sm px-1" style={{ background: `color-mix(in srgb, ${C.ac} 14%, var(--bw-sf))`, color: C.ac }}>{txt(t0, r)}</span>)}{L.length > 3 && <small style={{ color: C.mu }}>+{L.length - 3} more</small>}
      </div> })}
    </div></div>
  }
  const cards = () => <div className="grid max-h-[calc(100vh-330px)] gap-2 overflow-auto p-2 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">
    {shown.length ? shown.map(r => { const k = rid(r), s = sel.has(k), t0 = vis[0] || cols[0]; return <div key={k} className="cursor-pointer rounded-md border px-2.5 py-2" style={{ borderColor: s ? C.ac : C.ln, background: C.sf }} onClick={() => onRow?.(r)}>
      <div className="flex items-center gap-1.5"><input type="checkbox" checked={s} onClick={e => e.stopPropagation()} onChange={() => toggle(k)} aria-label="Select" /><b className="flex-1 truncate">{t0.fn ? t0.fn(r) : txt(t0, r)}</b></div>
      {vis.filter(c => c !== t0).slice(0, 6).map(c => <div key={c.k} className="flex justify-between gap-2 border-b py-0.5 text-xs last:border-0" style={{ borderColor: C.ln2 }}><small style={{ color: C.mu }}>{c.t}</small><span>{c.fn ? c.fn(r) : txt(c, r)}</span></div>)}
    </div> }) : <div className="col-span-full p-4 text-center text-xs" style={{ color: C.mu }}>No records match.</div>}
  </div>

  const tw = vis.reduce((a, c) => a + width(c), 0) + 34 + (menu ? 34 : 0)
  return <div>
    <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: C.ln }}>
      <div className="relative"><Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: C.mu }} /><input className={`${inputCls} !w-[210px] pl-[26px]`} style={inputStyle} placeholder="Search all columns…" value={q} onChange={e => { setQ(e.target.value); setPage(1) }} /></div>
      <div className="flex">{VIEWS.map(([v, icon, n], i) => <button key={v} type="button" title={`${n} view`} aria-label={`${n} view`} onClick={() => { setVw(v); setPage(1) }} className={`inline-flex h-6 items-center border px-2 ${i ? 'border-l-0' : 'rounded-l-md'} ${i === VIEWS.length - 1 ? 'rounded-r-md' : ''}`} style={vw === v ? { background: C.ac, borderColor: C.ac, color: '#fff' } : { background: C.sf, borderColor: C.ln, color: C.tx }}>{icon}</button>)}</div>
      {tools}
      <Btn s p={adv.conds.some(c => c.k)} onClick={() => setAdvDraft({ logic: adv.logic, conds: adv.conds.length ? adv.conds.map(c => ({ ...c })) : [{ k: cols[1]?.k || cols[0].k, op: 'contains', v: '' }] })}><Filter size={12} /> Filter{adv.conds.filter(c => c.k).length ? ` (${adv.conds.filter(c => c.k).length})` : ''}</Btn>
      <Btn s p={fr} onClick={() => setFr(x => !x)} title="Column filter row"><Table2 size={12} /> Quick filters</Btn>
      <select className={`${inputCls} !h-6 !w-32 text-xs`} style={inputStyle} value={grp} onChange={e => setGrp(e.target.value)} title="Group rows"><option value="">No grouping</option>{groupable.map(c => <option key={c.k} value={c.k}>Group: {c.t}</option>)}</select>
      <span className="flex-1" />
      <span ref={viewsBtn} data-bw-pop><Btn s onClick={() => setPop(p => p === 'views' ? null : 'views')}><Star size={12} /> Views{cur ? `: ${cur}` : ''}</Btn></span>
      {pop === 'views' && <Pop anchor={viewsBtn} minWidth={260}>
        <div className="it" role="button" onClick={() => apply(null)}><Table2 size={13} /> <b>All records</b> <small style={{ color: C.mu }}>reset view</small></div>
        {saved.map(v => <div key={v.id} className="it"><span className="flex-1" role="button" onClick={() => apply(v)}>{v.def ? '★ ' : ''}{v.n}</span><a role="button" title="Set as default" onClick={() => setSaved(s => s.map(x => ({ ...x, def: x.id === v.id ? !x.def : false })))}>★</a> <a role="button" title="Delete" onClick={() => setSaved(s => s.filter(x => x.id !== v.id))}>✕</a></div>)}
        <div className="it" role="button" onClick={saveView}>+ Save current view…</div>
      </Pop>}
      <span ref={colsBtn} data-bw-pop><Btn s onClick={() => setPop(p => p === 'cols' ? null : 'cols')}><Columns3 size={12} /> Columns</Btn></span>
      {pop === 'cols' && <Pop anchor={colsBtn} minWidth={210}>
        <div className="pop-h">Visible columns <a role="button" onClick={() => { setHide(new Set()); setW({}) }}>Reset</a></div>
        {cols.map(c => <label key={c.k} className="it"><input type="checkbox" checked={!hide.has(c.k)} onChange={e => setHide(h => { const n = new Set(h); if (e.target.checked) n.delete(c.k); else n.add(c.k); return n })} /> {c.t}</label>)}
      </Pop>}
      <Btn s onClick={() => setDen(d => ({ cmp: 'reg', reg: 'cozy', cozy: 'cmp' } as const)[d])} title="Row density"><Menu size={12} /> {DENS[den][0]}</Btn>
      {canExport && <Btn s p onClick={() => setExp({ fmt: 'CSV', scope: sel.size ? 'sel' : 'flt', hdr: true, cols: vis.map(c => c.k) })}><Download size={12} /> Export</Btn>}
    </div>
    {chips.length > 0 && <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-1" style={{ borderColor: C.ln, background: C.hd }}>
      {chips.map(([k, t]) => <span key={k} className="inline-flex items-center gap-1 rounded-[9px] px-2 text-[11px] leading-[18px] text-white" style={{ background: C.ac }}>{t} <button type="button" onClick={() => dropChip(k)} aria-label="Remove filter"><X size={10} /></button></span>)}
      <button type="button" className="text-xs" style={{ color: C.ac }} onClick={clearAll}>Clear all</button><button type="button" className="text-xs" style={{ color: C.ac }} onClick={saveView}>Save as view</button>
    </div>}
    {sel.size > 0 && <div className="flex flex-wrap items-center gap-2.5 px-2.5 py-1 text-white" style={{ background: C.ac }}>
      <span><b>{sel.size}</b> selected</span>
      {bulk.map(([l, fn]) => <button key={l} type="button" className="h-6 rounded-md border border-white/40 bg-white/10 px-2 text-xs font-medium hover:bg-white/20" onClick={() => fn(selected)}>{l}</button>)}
      {canExport && <button type="button" className="h-6 rounded-md border border-white/40 bg-white/10 px-2 text-xs font-medium hover:bg-white/20" onClick={() => setExp({ fmt: 'CSV', scope: 'sel', hdr: true, cols: vis.map(c => c.k) })}>Export selected</button>}
      <button type="button" className="h-6 rounded-md border border-white/40 bg-white/10 px-2 text-xs font-medium hover:bg-white/20" onClick={() => setSel(new Set())}>Clear</button>
    </div>}

    {vw === 'cards' ? cards() : vw === 'chart' ? chart() : vw === 'calendar' ? calendar() : <div className="bw-gscroll">
      <table className={`bw-gt ${den}`} style={{ width: `max(100%, ${tw}px)` }}>
        <colgroup><col style={{ width: 34 }} />{vis.map(c => <col key={c.k} style={{ width: width(c) }} />)}{menu && <col style={{ width: 34 }} />}</colgroup>
        <thead>
          <tr><th className="ck"><input type="checkbox" aria-label="Select all" checked={allOnPage} onChange={() => setSel(s => { const n = new Set(s); shown.forEach(r => allOnPage ? n.delete(rid(r)) : n.add(rid(r))); return n })} /></th>
            {vis.map((c, i) => { const si = sorts.findIndex(x => x[0] === c.k); return <th key={c.k} className={`so ${cellCls(c, i)}`} title="Click to sort · Shift-click for multi-sort" onClick={e => sortBy(c.k, e.shiftKey)}>
              {c.t}{si >= 0 && <small style={{ color: C.ac }}> {sorts[si][1] > 0 ? '▲' : '▼'}{sorts.length > 1 ? si + 1 : ''}</small>}
              <i className="rz" onClick={e => e.stopPropagation()} onMouseDown={e => { e.stopPropagation(); drag.current = { k: c.k, x: e.clientX, w: width(c) } }} />
            </th> })}{menu && <th className="ra" aria-label="Actions" />}</tr>
          {fr && <tr className="gfr"><th className="ck" />{vis.map((c, i) => <th key={c.k} className={i === 0 ? 'pin' : ''}><input className={`${inputCls} !h-[22px] text-xs`} style={inputStyle} placeholder="Filter" value={f[c.k] || ''} onChange={e => { setF(x => ({ ...x, [c.k]: e.target.value })); setPage(1) }} /></th>)}{menu && <th className="ra" />}</tr>}
        </thead>
        <tbody>{tableBody()}</tbody>
        {vis.some(c => c.sum) && <tfoot><tr><td className="ck" />{vis.map((c, i) => <td key={c.k} className={cellCls(c, i)}>{c.sum ? fmt(c, sumOf(c, all)) : i === 0 ? `Σ ${total} rows` : ''}</td>)}{menu && <td className="ra" />}</tr></tfoot>}
      </table>
    </div>}
    {pop === 'row' && menuRow && menu && <Pop anchor={menuBtn as RefObject<HTMLElement>} minWidth={160}>
      <div role="menu">{menu(menuRow).map(m => <div key={m.l} role="menuitem" tabIndex={0} className={`it ${m.danger ? 'bad' : ''}`}
        onClick={() => { setPop(null); m.fn() }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPop(null); m.fn() } }}>{m.i} {m.l}</div>)}</div>
    </Pop>}

    <div className="flex items-center gap-1.5 border-t px-2 py-1.5 text-xs" style={{ borderColor: C.ln, color: C.mu }}>
      <span>{flat ? `${total} records` : `${total ? (pg - 1) * size + 1 : 0}–${Math.min(total, pg * size)} of ${total}`}{!server && total !== rows.length && <small> (filtered from {rows.length})</small>}</span>
      <span className="flex-1" />
      {!flat && <><label className="flex items-center gap-1">Rows <select className={`${inputCls} !h-6 !w-16 text-xs`} style={inputStyle} value={size} onChange={e => { setSize(Number(e.target.value)); setPage(1) }}>{[10, 25, 50, 100, 250].map(n => <option key={n}>{n}</option>)}</select></label>
        <Btn s disabled={pg <= 1} onClick={() => setPage(pg - 1)}>‹</Btn><span>Page {pg} / {pages}</span><Btn s disabled={pg >= pages} onClick={() => setPage(pg + 1)}>›</Btn></>}
    </div>

    {advDraft && <BwModal title="Advanced filter" width={640} onClose={() => setAdvDraft(null)} foot={<><Btn onClick={() => { setAdv({ logic: 'AND', conds: [] }); setAdvDraft(null) }}>Clear</Btn><Btn onClick={() => setAdvDraft(null)}>Cancel</Btn><Btn p onClick={() => { setAdv({ logic: advDraft.logic, conds: advDraft.conds.filter(c => c.k) }); setPage(1); setAdvDraft(null) }}>Apply filter</Btn></>}>
      <div className="mb-2 flex items-center gap-2 text-xs">Match <select className={`${inputCls} !w-auto`} style={inputStyle} value={advDraft.logic} onChange={e => setAdvDraft({ ...advDraft, logic: e.target.value as 'AND' | 'OR' })}><option value="AND">all conditions (AND)</option><option value="OR">any condition (OR)</option></select></div>
      {advDraft.conds.map((cd, i) => <div key={i} className="mb-1.5 grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5">
        <select className={inputCls} style={inputStyle} value={cd.k} onChange={e => setAdvDraft({ ...advDraft, conds: advDraft.conds.map((x, j) => j === i ? { ...x, k: e.target.value } : x) })}>{cols.map(c => <option key={c.k} value={c.k}>{c.t}</option>)}</select>
        <select className={inputCls} style={inputStyle} value={cd.op} onChange={e => setAdvDraft({ ...advDraft, conds: advDraft.conds.map((x, j) => j === i ? { ...x, op: e.target.value } : x) })}>{OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
        <input className={inputCls} style={inputStyle} disabled={['empty', 'nempty'].includes(cd.op)} value={cd.v} onChange={e => setAdvDraft({ ...advDraft, conds: advDraft.conds.map((x, j) => j === i ? { ...x, v: e.target.value } : x) })} />
        <Btn s onClick={() => setAdvDraft({ ...advDraft, conds: advDraft.conds.filter((_, j) => j !== i) })}>✕</Btn>
      </div>)}
      <Btn s onClick={() => setAdvDraft({ ...advDraft, conds: [...advDraft.conds, { k: cols[0].k, op: 'contains', v: '' }] })}>+ Add condition</Btn>
    </BwModal>}

    {exp && (() => { const o = exportText(exp); return <BwModal title={<span className="inline-flex items-center gap-1.5"><Download size={14} /> Export data</span>} width={820} onClose={() => setExp(null)} foot={<><small className="flex-1 self-center text-xs" style={{ color: C.mu }}>Exports include only the platform fields shown in this list.</small><Btn onClick={() => setExp(null)}>Cancel</Btn><Btn p onClick={download}>Download {exp.fmt}</Btn></>}>
      <div className="grid gap-3 md:grid-cols-[250px_minmax(0,1fr)]">
        <div className="space-y-2">
          <Field label="Format"><select className={inputCls} style={inputStyle} value={exp.fmt} onChange={e => setExp({ ...exp, fmt: e.target.value as keyof typeof EXF })}>{Object.keys(EXF).map(k => <option key={k}>{k}</option>)}</select></Field>
          <div><span className="mb-0.5 block text-xs" style={{ color: C.mu }}>Rows to export</span>{([['flt', `Current result (${total})`], ['all', `All records (${rows.length})`], ['sel', `Selected rows (${sel.size})`]] as const).map(([v, l]) => <label key={v} className="flex items-center gap-1.5"><input type="radio" checked={exp.scope === v} disabled={v === 'sel' && !sel.size} onChange={() => setExp({ ...exp, scope: v })} /> {l}</label>)}</div>
          <label className="flex items-center gap-1.5"><input type="checkbox" checked={exp.hdr} onChange={e => setExp({ ...exp, hdr: e.target.checked })} /> Include header row</label>
          <div><span className="mb-0.5 block text-xs" style={{ color: C.mu }}>Columns · <button type="button" style={{ color: C.ac }} onClick={() => setExp({ ...exp, cols: cols.map(c => c.k) })}>all</button> · <button type="button" style={{ color: C.ac }} onClick={() => setExp({ ...exp, cols: [] })}>none</button></span>
            <div className="max-h-[150px] overflow-auto rounded-md border px-2 py-1" style={{ borderColor: C.ln }}>{cols.map(c => <label key={c.k} className="flex items-center gap-1.5"><input type="checkbox" checked={exp.cols.includes(c.k)} onChange={e => setExp({ ...exp, cols: e.target.checked ? [...exp.cols, c.k] : exp.cols.filter(x => x !== c.k) })} /> {c.t}</label>)}</div></div>
        </div>
        <div><span className="mb-0.5 block text-xs" style={{ color: C.mu }}>Preview · {o.n} rows, {exp.cols.length} columns</span><textarea readOnly rows={16} className="w-full rounded-md border p-2 font-mono text-xs" style={{ background: '#0E1621', color: '#D3E4F6', borderColor: '#2A3A4D', whiteSpace: 'pre' }} value={o.text.split('\n').slice(0, 40).join('\n')} /></div>
      </div>
    </BwModal> })()}
  </div>
}
