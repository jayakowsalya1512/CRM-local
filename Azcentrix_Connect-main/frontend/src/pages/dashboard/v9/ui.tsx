import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn, C, Chip, Drawer, Empty, Panel, Pill, Strip, inputCls, inputStyle, type StripItem } from '@/components/platform/bw'
import { HBars } from '@/components/platform/charts'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { fetchRecords, type Period } from './data'

// ── Drill-down ────────────────────────────────────────────────────────────────
// Every KPI card, chart element and table row opens one of these. Records come page by page from
// GET /dashboard/v9/records/{source}?filter=…, which uses the same filter as the number that was clicked.
export type DrillSpec = {
  title: string
  value?: ReactNode
  sub?: ReactNode
  source?: string
  filter?: string
  cols?: GridCol<any>[]
  breakdown?: { l: string; v: number; text: string }[]
  body?: ReactNode
  route?: { label: string; to: string }
  rowTo?: (r: any) => string | null
}

const DrillCtx = createContext<(s: DrillSpec) => void>(() => {})
export const DrillProvider = DrillCtx.Provider
export const useDrill = () => useContext(DrillCtx)

export function DrillDrawer({ spec, period, onClose }: { spec: DrillSpec; period: Period; onClose: () => void }) {
  const navigate = useNavigate()
  const go = (path: string) => { onClose(); navigate(path) }
  return <Drawer width={880} onClose={onClose} title={spec.title} sub={spec.sub}
    act={spec.route ? <Btn s onClick={() => go(spec.route!.to)}>Open {spec.route.label}</Btn> : undefined}>
    {spec.value != null && <div className="mb-3 text-[26px] font-semibold tracking-tight" style={{ color: C.tx }}>{spec.value}</div>}
    {spec.body && <div className="mb-3">{spec.body}</div>}
    {spec.breakdown && spec.breakdown.length > 0 && <Panel title="Breakdown" className="mb-3"><HBars rows={spec.breakdown} lw={160} vw={96} /></Panel>}
    {spec.source && spec.cols && <RecordGrid spec={spec} period={period} onNavigate={go} />}
    <div className="mt-3 flex justify-end gap-2">
      {spec.route && <Btn p onClick={() => go(spec.route!.to)}>Open {spec.route.label}</Btn>}
      <Btn onClick={onClose}>Close</Btn>
    </div>
  </Drawer>
}

// Server-paged record grid: status chips, date range, search, sorting and paging all go to /dashboard/v9/records.
// Used inside the drill drawer and on its own (Login history).
export function RecordGrid({ spec, period, onNavigate, framed = true }: { spec: DrillSpec; period: Period; onNavigate?: (path: string) => void; framed?: boolean }) {
  const navigate = useNavigate()
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [paging, setPaging] = useState<{ offset: number; limit: number; sort: string; dir: 'asc' | 'desc' }>({ offset: 0, limit: 25, sort: '', dir: 'desc' })
  const [page, setPage] = useState<{ rows: any[]; total: number; statuses: string[]; dateKey: string | null; loading: boolean; error: string | null }>({ rows: [], total: 0, statuses: [], dateKey: null, loading: true, error: null })
  const seq = useRef(0)
  const source = spec.source!, filter = spec.filter || 'all'

  useEffect(() => {
    const n = ++seq.current
    setPage(p => ({ ...p, loading: true, error: null }))
    fetchRecords(source, { filter, period, q, status, date_from: from, date_to: to, sort: paging.sort, dir: paging.dir, page: Math.floor(paging.offset / paging.limit) + 1, page_size: paging.limit })
      .then(r => { if (n === seq.current) setPage(p => ({ rows: r.rows, total: r.total, statuses: p.statuses.length && (status || q || from || to) ? p.statuses : r.statuses, dateKey: r.date_key, loading: false, error: null })) })
      .catch(err => { if (n === seq.current) setPage(p => ({ ...p, loading: false, error: err?.response?.data?.detail || 'Could not load records' })) })
  }, [source, filter, period, q, status, from, to, paging])

  const onServer = useCallback((s: { offset: number; limit: number; sorts: [string, number][] }) => {
    const [k, d] = s.sorts[0] ?? ['', -1]
    const dir = d > 0 ? 'asc' : 'desc'
    setPaging(p => (p.offset === s.offset && p.limit === s.limit && p.sort === k && p.dir === dir ? p : { offset: s.offset, limit: s.limit, sort: k, dir }))
  }, [])
  const reset = () => setPaging(p => ({ ...p, offset: 0 }))
  const go = onNavigate ?? ((path: string) => navigate(path))

  return <>
    <div className={`mb-2 flex flex-wrap items-center gap-1.5 ${framed ? '' : 'px-3 pt-3'}`}>
      {page.statuses.length > 1 && <>
        <Chip on={!status} onClick={() => { setStatus(''); reset() }}>All</Chip>
        {page.statuses.map(s => <Chip key={s} on={status === s} onClick={() => { setStatus(status === s ? '' : s); reset() }}>{s}</Chip>)}
      </>}
      {page.dateKey && <span className="ml-auto flex flex-wrap items-center gap-1.5 text-xs" style={{ color: C.mu }}>
        From <input type="date" aria-label="From date" className={inputCls} style={{ ...inputStyle, width: 140 }} value={from} onChange={e => { setFrom(e.target.value); reset() }} />
        to <input type="date" aria-label="To date" className={inputCls} style={{ ...inputStyle, width: 140 }} value={to} onChange={e => { setTo(e.target.value); reset() }} />
        {(from || to) && <Btn g s onClick={() => { setFrom(''); setTo(''); reset() }}>Clear</Btn>}
      </span>}
    </div>
    {page.error ? <Empty>{page.error}</Empty> : <div className={framed ? 'bw-panel' : ''} aria-busy={page.loading}>
      <BwGrid id={`dash-${source}-${filter.split(':')[0]}`} cols={spec.cols!} rows={page.rows} rid={(r: any) => String(r.id)}
        server={{ total: page.total, onChange: onServer }}
        onQuery={s => { if (s.q !== q) { setQ(s.q); reset() } }}
        onRow={spec.rowTo ? (r => { const p = spec.rowTo!(r); if (p) go(p) }) : undefined}
        empty={page.loading ? 'Loading…' : 'No records for this selection.'} />
    </div>}
  </>
}

// ── Panels ────────────────────────────────────────────────────────────────────
export function Sec({ t, act, flush, children, className = '' }: { t: string; act?: ReactNode; flush?: boolean; children: ReactNode; className?: string }) {
  return <Panel className={className} flush={flush} act={act} title={t}>{children}</Panel>
}

// Shown where the CRM does not record what a section needs (e.g. win probabilities), instead of an invented figure.
export const Unavailable = ({ children }: { children: ReactNode }) => <div className="px-2 py-6 text-center text-[12.5px] leading-relaxed" style={{ color: C.mu }}>
  <Pill t="mu">Not available</Pill><div className="mt-2">{children}</div>
</div>
export const NoAccess = ({ what }: { what: string }) => <Empty>You don't have permission to view {what}. Ask your administrator to enable it under Roles &amp; Permissions.</Empty>
export const LoadingBox = () => <Empty>Loading…</Empty>
export const ErrorBox = ({ msg }: { msg: string }) => <Empty>{msg}</Empty>

// Prototype funnel() with clickable stages (same .fnl2 markup and colours as the shared chart, plus onPick).
export function PickFunnel({ data, onPick }: { data: { l: string; v: number }[]; onPick?: (i: number) => void }) {
  const mx = Math.max(...data.map(d => d.v), 1)
  return <div className="fnl2">{data.map((d, i) => <div key={d.l}>
    {i > 0 && <div className="fcv">{data[i - 1].v && d.v <= data[i - 1].v ? `↓ ${Math.round(d.v / data[i - 1].v * 100)}%` : ''}</div>}
    <div className={`frow ${onPick ? 'cursor-pointer' : ''}`} title={`${d.l}: ${d.v.toLocaleString('en-IN')}`} onClick={onPick ? () => onPick(i) : undefined}
      role={onPick ? 'button' : undefined} tabIndex={onPick ? 0 : undefined} onKeyDown={onPick ? e => { if (e.key === 'Enter') onPick(i) } : undefined}>
      <span className="fln" title={d.l}>{d.l}</span>
      <div className="ftr"><div className="fbar" style={{ width: `${Math.max(9, d.v / mx * 100)}%`, background: `linear-gradient(90deg, color-mix(in srgb, var(--bw-ac) ${100 - i * 9}%, #fff), color-mix(in srgb, var(--bw-ac) ${96 - i * 9}%, #000))` }}><b>{d.v.toLocaleString('en-IN')}</b></div></div>
    </div>
  </div>)}</div>
}

// ── KPI strip ─────────────────────────────────────────────────────────────────
export type Kpi = Omit<StripItem, 'onClick'> & { drill?: () => DrillSpec }
export function Kpis({ items }: { items: Kpi[] }) {
  const open = useDrill()
  return <Strip items={items.map(({ drill, ...x }) => ({ ...x, title: `${x.l} — click for details`, onClick: drill ? () => open(drill()) : undefined }))} />
}

export const statusPill = (s: string | null | undefined) => {
  const v = String(s || '—')
  const t = /won|approved|active|success|converted|completed|paid|closed/i.test(v) ? 'ok' : /lost|rejected|failed|blocked|expired|overdue|cancel|revoked|delayed/i.test(v) ? 'ba' : /pending|due|review|draft|hold|request/i.test(v) ? 'wa' : 'inf'
  return <Pill t={t as any}>{v}</Pill>
}
