import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import { platformApi, type KpiColumnKind, type KpiDetail, type KpiQuery } from '@/services/platformApi'
import { Btn, C, Empty, Ic, Pill, cap, downloadBlob, errMsg, fd, fdt, inr, inputCls, inputStyle, mb, num, statusTone } from './bw'

// KPI drill-down popup opened from any KPI card (Strip / Hero `kpi` key). Every figure comes from GET /platform/kpi/{key}:
// header (title, record count, export / refresh / maximize / close), filters, records (sortable, click to open) and pagination. Look follows the prototype .md dialog and the platform tokens, so light and dark both apply.
const size = (b: number) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`

export function fmtKpi(v: any, kind: KpiColumnKind): ReactNode {
  if (v == null || v === '') return <span style={{ color: C.mu }}>—</span>
  switch (kind) {
    case 'num': return typeof v === 'number' ? (Number.isInteger(v) ? num(v) : v.toLocaleString('en-IN', { maximumFractionDigits: 2 })) : String(v)
    case 'inr': return inr(Number(v))
    case 'pct': return `${Number(Number(v).toFixed(1))}%`
    case 'date': return fd(v)
    case 'datetime': return fdt(v)
    case 'pill': return <Pill t={statusTone(String(v))}>{cap(String(v))}</Pill>
    case 'mb': return mb(Number(v))
    case 'bytes': return size(Number(v))
    case 'ms': return `${num(Number(v))} ms`
    case 'bool': return v ? 'Yes' : 'No'
    case 'code': return <code className="text-xs">{String(v)}</code>
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

const linkFor = (tpl: string | null, row: Record<string, any>) => {
  if (!tpl) return null
  let missing = false
  const to = tpl.replace(/\{(\w+)\}/g, (_, k) => { const v = row[k]; if (v == null || v === '') missing = true; return encodeURIComponent(String(v)) })
  return missing ? null : to
}

const PAGE_SIZES = [10, 25, 50, 100]

// `fixed` filters stay applied (e.g. a tenant detail page passes its tenant_id); the user's filters add to them.
export default function KpiPopup({ kpi, title, fixed, onClose }: { kpi: string; title: string; value?: ReactNode; fixed?: KpiQuery; onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState<KpiQuery>({ ...fixed, page: 1, page_size: 25 })
  const [search, setSearch] = useState('')
  const [data, setData] = useState<KpiDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState('')
  const [record, setRecord] = useState<Record<string, any> | null>(null)
  const [maximized, setMaximized] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try { const { data: next } = await platformApi.kpiDetail(kpi, query); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Unable to load the records behind this KPI')) }
    finally { if (mine === seq.current) setLoading(false) }
  }, [kpi, query])
  useEffect(() => { void load() }, [load])

  // Search is debounced so typing doesn't fire one request per key.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q => (q.q ?? '') === search.trim() ? q : { ...q, q: search.trim() || undefined, page: 1 }), 300)
    return () => window.clearTimeout(t)
  }, [search])

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    dialog.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; prev?.focus?.() }
  }, [onClose])

  const set = (patch: KpiQuery) => { setQuery(q => ({ ...q, ...patch, page: patch.page ?? 1 })); setRecord(null) }
  const reset = () => { setSearch(''); setQuery({ ...fixed, page: 1, page_size: query.page_size }); setRecord(null) }
  const filtered = !!(query.q || (query.status && query.status !== fixed?.status) || (query.tenant_id && query.tenant_id !== fixed?.tenant_id) || query.date_from || query.date_to || (query.facet != null && query.facet !== fixed?.facet))
  const exportCsv = async () => {
    setExporting(true); setExported('')
    try { const { data: blob } = await platformApi.kpiExport(kpi, { ...query, page: undefined, page_size: undefined }); downloadBlob(blob, `${kpi.replace(/\./g, '-')}.csv`); setExported('Export downloaded') }
    catch (err) { setError(errMsg(err, 'Export failed')) } finally { setExporting(false) }
  }

  const cols = data?.columns.filter(c => !c.hidden) ?? []
  const sortKey = query.sort ?? data?.sort ?? null
  const desc = query.dir ? query.dir === 'desc' : data?.desc ?? true
  const toggleSort = (key: string) => set({ sort: key, dir: sortKey === key ? (desc ? 'asc' : 'desc') : 'desc', page: query.page })
  const total = data?.total ?? 0
  const page = query.page ?? 1, pageSize = query.page_size ?? 25
  const pages = Math.max(1, Math.ceil(total / pageSize))

  // Header follows the application's records popups: title + record count on the left; export, refresh, maximize and close on the right.
  return <div className="bw-ov bw-kpi-ov" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div ref={dialog} tabIndex={-1} className={`bw-md bw-kpi ${maximized ? 'max' : ''}`} role="dialog" aria-modal="true" aria-labelledby="bw-kpi-title">
      <div className="kh">
        <div className="min-w-0 flex-1">
          <h2 id="bw-kpi-title" className="kt">{title}</h2>
          <p className="kd">{data ? `${num(total)} record${total === 1 ? '' : 's'}${filtered ? ' · filtered' : ''}` : 'Loading…'}{data?.description ? ` · ${data.description}` : ''}</p>
        </div>
        <div className="ka">
          {exported && <small style={{ color: C.ok }}>{exported}</small>}
          <button type="button" className="kx" onClick={() => void exportCsv()} disabled={exporting || !total} title={exporting ? 'Exporting…' : 'Export CSV'} aria-label="Export CSV"><Download size={16} /></button>
          <button type="button" className="kx" onClick={() => void load()} disabled={loading} title="Refresh" aria-label="Refresh"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
          <button type="button" className="kx" onClick={() => setMaximized(v => !v)} title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore popup' : 'Maximize popup'}>{maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button type="button" className="kx" onClick={onClose} title="Close" aria-label="Close"><X size={16} /></button>
        </div>
      </div>

      <div className="kb">
        {data?.note && <div className="kn">{data.note}</div>}

        {/* 3. Filters */}
        {data && (data.search || data.status_filter || data.tenant_filter || data.date_filter) && <div className="kf">
          {data.search && <span className="kfs"><Ic n="search" /><input className={inputCls} style={inputStyle} value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" aria-label="Search records" /></span>}
          {data.status_filter && <select className={inputCls} style={inputStyle} value={query.status ?? ''} onChange={e => set({ status: e.target.value || undefined })} aria-label="Status">
            <option value="">All statuses</option>{data.statuses.map(s => <option key={s} value={s}>{cap(s)}</option>)}</select>}
          {data.tenant_filter && !fixed?.tenant_id && data.tenants.length > 1 && <select className={inputCls} style={inputStyle} value={query.tenant_id ?? ''} onChange={e => set({ tenant_id: e.target.value ? Number(e.target.value) : undefined })} aria-label="Tenant">
            <option value="">All tenants</option>{data.tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
          {data.date_filter && <>
            <input type="date" className={inputCls} style={inputStyle} value={query.date_from ?? ''} max={query.date_to} onChange={e => set({ date_from: e.target.value || undefined })} aria-label="From date" />
            <input type="date" className={inputCls} style={inputStyle} value={query.date_to ?? ''} min={query.date_from} onChange={e => set({ date_to: e.target.value || undefined })} aria-label="To date" />
          </>}
          {query.facet != null && query.facet !== fixed?.facet && <button type="button" className="bw-chip on" onClick={() => set({ facet: undefined })}>{query.facet || 'Not set'} <X size={11} /></button>}
          {filtered && <Btn s g onClick={reset}>Clear filters</Btn>}
        </div>}

        {/* 4. Data */}
        {error ? <div className="ke" role="alert"><span>{error}</span><Btn s onClick={() => void load()}>Retry</Btn></div>
          : record && data ? <RecordView data={data} row={record} onBack={() => setRecord(null)} onOpen={to => { onClose(); navigate(to) }} />
          : !data ? <Empty>Loading…</Empty>
          : !data.rows.length ? <Empty>{loading ? 'Loading…' : filtered ? 'No records match these filters' : 'No records behind this KPI yet'}</Empty>
          : <div className={`kt-wrap ${loading ? 'busy' : ''}`}><table className="w-full text-left" style={{ minWidth: Math.max(480, cols.length * 120) }}>
            <thead><tr>{cols.map(c => <th key={c.key} aria-sort={sortKey === c.key ? (desc ? 'descending' : 'ascending') : undefined}>
              <button type="button" className="ksort" onClick={() => toggleSort(c.key)}>{c.label}{sortKey === c.key && (desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}</button></th>)}</tr></thead>
            <tbody>{data.rows.map((r, i) => <tr key={i} className="clk" tabIndex={0} onClick={() => setRecord(r)} onKeyDown={e => { if (e.key === 'Enter') setRecord(r) }}>
              {cols.map(c => <td key={c.key} className={['num', 'inr', 'pct', 'mb', 'bytes', 'ms'].includes(c.kind) ? 'text-right tabular-nums' : ''}>{fmtKpi(r[c.key], c.kind)}</td>)}
            </tr>)}</tbody>
          </table></div>}
      </div>

      {!record && total > 0 && <div className="pf kfoot">
        <div className="kpg">
          <select className={inputCls} style={inputStyle} value={pageSize} onChange={e => set({ page_size: Number(e.target.value) })} aria-label="Rows per page">{PAGE_SIZES.map(n => <option key={n} value={n}>{n} / page</option>)}</select>
          <span style={{ color: C.mu }}>{num((page - 1) * pageSize + 1)}–{num(Math.min(total, page * pageSize))} of {num(total)}</span>
          <Btn s disabled={page <= 1 || loading} onClick={() => set({ page: page - 1 })} title="Previous page"><ChevronLeft size={13} /></Btn>
          <Btn s disabled={page >= pages || loading} onClick={() => set({ page: page + 1 })} title="Next page"><ChevronRight size={13} /></Btn>
        </div>
      </div>}
    </div>
  </div>
}

function RecordView({ data, row, onBack, onOpen }: { data: KpiDetail; row: Record<string, any>; onBack: () => void; onOpen: (to: string) => void }) {
  const to = linkFor(data.link, row)
  return <div className="krec">
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <Btn s onClick={onBack}><ChevronLeft size={13} /> Back to records</Btn>
      <span className="flex-1" />
      {to && <Btn s p onClick={() => onOpen(to)}><Ic n="eye" /> Open record</Btn>}
    </div>
    <div className="grid gap-x-[18px] sm:grid-cols-2">{data.columns.map(c => <div key={c.key} className="flex justify-between gap-2.5 border-b py-[6px]" style={{ borderColor: C.ln2 }}>
      <span style={{ color: C.mu }}>{c.label}</span><span className="min-w-0 break-words text-right">{fmtKpi(row[c.key], c.kind)}</span>
    </div>)}</div>
  </div>
}
