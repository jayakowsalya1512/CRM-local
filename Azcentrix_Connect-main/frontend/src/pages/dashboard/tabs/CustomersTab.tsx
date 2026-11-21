/**
 * CustomersTab.tsx — Customer Analytics
 * Correct field names: customer_name, billing_state, customer_vertical, account_status, assigned_user_name, potential_value
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { Filter } from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  fmtN, fmtRsL, num, pct,
  ChartTip, Badge, DataTable,
  Section, TabSkeleton,
  ColDef, AXIS_X, AXIS_Y, CGRID,
} from './_shared'

// ─── field helpers ────────────────────────────────────────────────────────────
const cName    = (r: any) => r.customer_name || r.name || r.company_name || '—'
const cState   = (r: any) => r.billing_state || r.state || ''
const normalizeSectorLabel = (value: any) => {
  const cleaned = String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const aliases: Record<string, string> = {
    'central government': 'Central Government',
    'state government': 'State Government',
    bfsi: 'BFSI',
    smb: 'SMB',
    defence: 'Defence',
  }
  return aliases[cleaned.toLowerCase()] || cleaned
}
const cSector  = (r: any) => normalizeSectorLabel(r.customer_vertical || r.industry || r.sector || r.vertical || '')
const cStatus  = (r: any) => r.account_status || r.status || ''
const cUser    = (r: any) => r.assigned_user_name || r.assigned_to || ''
const cPotential = (r: any) => num(r.potential_value || r.potential || 0)

// ─── State abbreviations ──────────────────────────────────────────────────────
const STATE_ABBR: Record<string, string> = {
  'Andhra Pradesh':'AP','Arunachal Pradesh':'AR','Assam':'AS','Bihar':'BR','Chandigarh':'CH',
  'Chhattisgarh':'CG','Delhi':'DL','Goa':'GA','Gujarat':'GJ','Haryana':'HR',
  'Himachal Pradesh':'HP','J&K':'JK','Jammu & Kashmir':'JK','Jharkhand':'JH',
  'Karnataka':'KA','Kerala':'KL','Ladakh':'LA','Madhya Pradesh':'MP','Maharashtra':'MH',
  'Manipur':'MN','Meghalaya':'ML','Mizoram':'MZ','Nagaland':'NL','Odisha':'OD',
  'Puducherry':'PY','Punjab':'PB','Rajasthan':'RJ','Sikkim':'SK','Tamil Nadu':'TN',
  'Telangana':'TS','Tripura':'TR','Uttar Pradesh':'UP','Uttarakhand':'UK','West Bengal':'WB',
}

// ─── useSectionDrag ───────────────────────────────────────────────────────────
function useSectionDrag(storageKey: string, defaultOrder: string[]) {
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed: string[] = JSON.parse(saved)
        const merged = parsed.filter(id => defaultOrder.includes(id))
        defaultOrder.forEach(id => { if (!merged.includes(id)) merged.push(id) })
        return merged
      }
    } catch { /* ignore */ }
    return defaultOrder
  })
  const dragSrc = useRef<string | null>(null)
  const onDragStart = useCallback((id: string) => { dragSrc.current = id }, [])
  const onDragOver  = useCallback((e: React.DragEvent) => { e.preventDefault() }, [])
  const onDrop      = useCallback((targetId: string) => {
    const src = dragSrc.current
    if (!src || src === targetId) return
    setOrder(prev => {
      const next = [...prev]
      const si = next.indexOf(src), ti = next.indexOf(targetId)
      next.splice(si, 1); next.splice(ti, 0, src)
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
    dragSrc.current = null
  }, [storageKey])
  return { order, onDragStart, onDragOver, onDrop }
}

// ─── DragSection ──────────────────────────────────────────────────────────────
function DragSection({ id, arranging, onDragStart, onDragOver, onDrop, children }: {
  id: string; arranging: boolean
  onDragStart: (id: string) => void
  onDragOver:  (e: React.DragEvent) => void
  onDrop:      (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div draggable={arranging} onDragStart={() => onDragStart(id)}
      onDragOver={onDragOver} onDrop={() => onDrop(id)}
      className={`relative ${arranging ? 'cursor-grab active:cursor-grabbing ring-2 ring-indigo-200 ring-offset-1 rounded-2xl' : ''}`}>
      {children}
    </div>
  )
}

// ─── Card helpers ─────────────────────────────────────────────────────────────
function SCard({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05)] ${className}`}>{children}</div>
}
function SCardHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="border-b border-slate-200/60 px-5 pt-4 pb-3">
      <div className="text-[13px] font-semibold text-slate-900">{title}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

// ─── Master group types ───────────────────────────────────────────────────────
type MasterGroup = { id: number; name: string; members?: { id: number }[] }
function getGroupKey(row: any, masterGroups: MasterGroup[]): string {
  const direct = row.group_name || row.assigned_group || row.team || row.group
  if (direct) return direct
  if (row.assigned_to && masterGroups.length) {
    const uid = Number(row.assigned_to)
    const g = masterGroups.find(mg => (mg.members || []).some(m => m.id === uid))
    if (g) return g.name
  }
  return 'Unassigned'
}

// ─── Unified Customer Comparison Table (Compare By) ──────────────────────────
type CustCompareBy = 'state' | 'sector' | 'group' | 'status' | 'user'
const CUST_COMPARE_OPTIONS: { value: CustCompareBy; label: string }[] = [
  { value: 'state',  label: 'State-wise'  },
  { value: 'sector', label: 'Sector-wise' },
  { value: 'group',  label: 'Group-wise'  },
  { value: 'status', label: 'Status-wise' },
  { value: 'user',   label: 'User-wise'   },
]

function CustomerComparisonTable({ rows, masterGroups }: { rows: any[]; masterGroups: MasterGroup[] }) {
  const { label, singular, labelLower } = useModuleName('customers')
  const { label: leadsLabel } = useModuleName('leads')
  const { label: tendersLabel } = useModuleName('tenders')
  const [compareBy, setCompareBy] = useState<CustCompareBy>('state')

  type Row = { key: string; count: number; active: number; potential: number; lead_val: number; tender_val: number; won_val: number }
  const data = useMemo(() => {
    const m = new Map<string, Row>()
    rows.forEach(r => {
      let k = ''
      if (compareBy === 'state')  k = cState(r)  || 'Unknown'
      if (compareBy === 'sector') k = cSector(r) || 'General'
      if (compareBy === 'group')  k = getGroupKey(r, masterGroups)
      if (compareBy === 'status') k = cStatus(r) || 'Unknown'
      if (compareBy === 'user')   k = cUser(r)   || 'Unassigned'

      if (!m.has(k)) m.set(k, { key:k, count:0, active:0, potential:0, lead_val:0, tender_val:0, won_val:0 })
      const e = m.get(k)!
      e.count++
      if ((cStatus(r)).toLowerCase() === 'active') e.active++
      e.potential  += num(r.potential_value || 0)
      e.lead_val   += num(r.lead_value   || r.total_lead_value   || 0)
      e.tender_val += num(r.tender_value || r.total_tender_value || 0)
      e.won_val    += num(r.won_value    || r.won_tender_value   || 0)
    })
    return [...m.values()].sort((a, b) => b.count - a.count).slice(0, 25)
  }, [rows, compareBy, masterGroups])

  const totalCount = rows.length || 1

  return (
    <SCard>
      {/* header + pills */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/60 px-5 py-3.5">
        <div>
          <div className="text-[13px] font-semibold text-slate-900">{singular} Comparison</div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            Grouped by <span className="font-semibold text-indigo-700">{CUST_COMPARE_OPTIONS.find(o => o.value === compareBy)?.label}</span> · {data.length} segments
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Compare by</span>
          {CUST_COMPARE_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setCompareBy(opt.value)}
              className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition-all ${
                opt.value === compareBy
                  ? 'border-indigo-600 bg-indigo-600 text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-700'
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] table-fixed text-[12.5px]">
          <colgroup>
            <col className="w-[21%]" />
            <col className="w-[7%]" />
            <col className="w-[7%]" />
            <col className="w-[15%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[11%]" />
            <col className="w-[13%]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-50/80 text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">
                {CUST_COMPARE_OPTIONS.find(o => o.value === compareBy)?.label.replace('-wise','') || 'Segment'}
              </th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-left">Total</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-center text-emerald-700">Active</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-center text-violet-700">Potential ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-center text-blue-700">{leadsLabel} ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-center text-amber-700">{tendersLabel} ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-center text-emerald-700">Won ₹</th>
              <th className="border-b border-slate-200 px-4 py-2.5 text-center" title={`% of total ${labelLower} in this segment`}>{label} Share</th>
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-400">No data</td></tr>
            ) : data.map((r, i) => {
              return (
                <tr key={r.key} className={`border-b border-slate-100 last:border-b-0 hover:bg-slate-50/60 transition-colors ${i % 2 === 0 ? '' : 'bg-slate-50/30'}`}>
                  <td className="px-4 py-2.5 font-medium text-slate-900 truncate" title={r.key}>{r.key}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-left font-bold tabular-nums text-indigo-700">{fmtN(r.count)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-center tabular-nums text-emerald-700 font-semibold">{fmtN(r.active)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-center tabular-nums font-semibold text-violet-700">{fmtRsL(r.potential)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-center tabular-nums text-blue-700">{fmtRsL(r.lead_val)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-center tabular-nums text-amber-700">{fmtRsL(r.tender_val)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-center tabular-nums font-semibold text-emerald-700">{fmtRsL(r.won_val)}</td>
                  <td className="px-4 py-2.5 align-middle">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-indigo-500 transition-all duration-700"
                          style={{ width: `${pct(r.count, totalCount)}%` }} />
                      </div>
                      <span className="w-[58px] shrink-0 text-[10px] text-slate-500 tabular-nums font-medium">
                        {r.count} <span className="text-slate-400">({pct(r.count, totalCount)}%)</span>
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </SCard>
  )
}

// ─── Section defaults ─────────────────────────────────────────────────────────
const CUST_SECTION_DEFAULTS = ['s_status','s_sector','s_comparison','s_top','s_table']

// ─── Main component ───────────────────────────────────────────────────────────
export default function CustomersTab() {
  const { label, singular, labelLower, singularLower } = useModuleName('customers')
  const { label: leadsLabel } = useModuleName('leads')
  const { label: tendersLabel } = useModuleName('tenders')
  const [loading,  setLoading]  = useState(true)
  const [stats,    setStats]    = useState<any>({})
  const [tableRows, setTableRows] = useState<any[]>([])
  const [masterGroups, setMasterGroups] = useState<MasterGroup[]>([])
  const [activeState,  setActiveState]  = useState<string | null>(null)
  const [activeSector, setActiveSector] = useState<string | null>(null)
  const [arranging,  setArranging]  = useState(false)

  const { order, onDragStart, onDragOver, onDrop } = useSectionDrag('crm_customers_sections_v2', CUST_SECTION_DEFAULTS)

  useEffect(() => {
    api.get('/groups/').then(r => {
      const items = Array.isArray(r.data?.items) ? r.data.items : Array.isArray(r.data) ? r.data : []
      setMasterGroups(items)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    const p: Record<string, string> = {}
    if (activeState) p.state = activeState
    if (activeSector)        p.sector      = activeSector

    Promise.all([
      api.get('/customers/stats', { params: p }).catch(() => ({ data: {} })),
      api.get('/customers/', { params: { ...p, page: 1, page_size: 300 } }).catch(() => ({ data: [] })),
    ]).then(([sRes, tRes]) => {
      setStats(sRes.data || {})
      const rows = Array.isArray(tRes.data?.items) ? tRes.data.items
                 : Array.isArray(tRes.data) ? tRes.data : []
      setTableRows(rows)
    }).finally(() => setLoading(false))
  }, [activeState, activeSector])

  const handleReset  = () => {
    setActiveState(null); setActiveSector(null)
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  // Sector distribution — all active segments from master table (via /customers/stats)
  const sectorDist = useMemo(() => {
    const apiVerticals: { name: string; value: number }[] = stats?.charts?.by_vertical || []
    if (apiVerticals.length > 0) {
      return apiVerticals.sort((a: any, b: any) => b.value - a.value)
    }
    // Fallback: compute from loaded rows if stats not yet available
    const m: Record<string, number> = {}
    tableRows.forEach(r => { const sc = cSector(r) || 'Other'; m[sc] = (m[sc] || 0) + 1 })
    return Object.entries(m).map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value).slice(0, 10)
  }, [stats, tableRows])

  // State distribution for horizontal bar chart
  const stateDist = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => { const st = cState(r) || 'Unknown'; m[st] = (m[st] || 0) + 1 })
    return Object.entries(m)
      .map(([state, count]) => ({ state, abbr: STATE_ABBR[state] || state.slice(0,6), count }))
      .sort((a, b) => b.count - a.count).slice(0, 15)
  }, [tableRows])

  // State quick-tiles (filter)
  const stateTiles = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => { const st = cState(r); if (st) m[st] = (m[st] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 18)
      .map(([state, count]) => ({ state, count }))
  }, [tableRows])

  const sectorChips = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => { const sc = cSector(r); if (sc) m[sc] = (m[sc] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([sector, count]) => ({ sector, count }))
  }, [tableRows])

  // Filtered rows
  const filteredRows = useMemo(() => tableRows.filter(r => {
    if (activeState  && cState(r)  !== activeState)  return false
    if (activeSector && cSector(r) !== activeSector) return false
    return true
  }), [tableRows, activeState, activeSector])

  // Top 10 by potential (only accounts with a value set)
  const topByPotential = useMemo(() =>
    filteredRows
      .filter(r => cPotential(r) > 0)
      .sort((a, b) => cPotential(b) - cPotential(a))
      .slice(0, 10)
      .map(r => ({
        name:      cName(r),
        value:     cPotential(r),
        sector:    cSector(r),
        state:     cState(r),
        status:    cStatus(r),
        potential: r.account_potential || '',
        kam:       cUser(r),
      })),
    [filteredRows])

  // DataTable columns — only columns that have real data
  const cols: ColDef[] = [
    { key: 'customer_name', label: singular,
      render: (v: string) => <span className="font-medium text-slate-800">{v || '—'}</span> },
    { key: 'billing_state',    label: 'State' },
    { key: 'customer_vertical',label: 'Sector' },
    { key: 'account_status',   label: 'Status',
      render: (v: string) => v ? <Badge text={v} /> : null },
    { key: 'account_potential',label: 'Category' },
    { key: 'potential_value',  label: 'Potential ₹',
      render: (v: any) => <span className="font-semibold text-violet-700">{fmtRsL(num(v))}</span> },
    { key: 'assigned_user_name', label: 'KAM' },
    { key: 'group_name',       label: 'Group' },
    { key: 'billing_city',     label: 'City' },
  ]

  if (loading) return <TabSkeleton />

  const maxState = stateDist[0]?.count || 1
  const maxStateTile = stateTiles[0]?.count || 1

  // ── Section map ────────────────────────────────────────────────────────────
  const sectionMap: Record<string, React.ReactNode> = {



    s_status: (
      <>
        <Section idx="02" title="Status & Sector Distribution" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SCard>
            <SCardHead title={`${label} by State`} sub="Top 15 states — click a bar to filter" />
            <div className="px-2 pb-3 pt-2">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={stateDist} layout="vertical" margin={{ top: 14, right: 28, left: 0, bottom: 6 }}>
                  <CartesianGrid {...CGRID} horizontal={false} />
                  <XAxis type="number" {...AXIS_X} tickFormatter={fmtN} />
                  <YAxis
                    type="category"
                    dataKey="state"
                    {...AXIS_Y}
                    width={124}
                    interval={0}
                    tickMargin={8}
                    padding={{ top: 6, bottom: 6 }}
                    tick={{ ...AXIS_Y.tick, fontSize: 11 }}
                  />
                  <Tooltip content={<ChartTip />}
                    formatter={(v: any, _n: string, p: any) => [fmtN(v), p.payload?.state || '']} />
                  <Bar dataKey="count" name={label} radius={[0, 4, 4, 0]}
                    onClick={(d: any) => setActiveState(s => s === d.state ? null : d.state)}>
                    {stateDist.map((d, i) => (
                      <Cell key={d.state}
                        fill={activeState === d.state ? '#4338ca'
                          : i < 3 ? '#6366f1' : i < 6 ? '#818cf8' : i < 10 ? '#a5b4fc' : '#c7d2fe'}
                        className="cursor-pointer" />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </SCard>
          <SCard>
            <SCardHead title="Top Segments" sub={`${label} count by industry / vertical with lead source breakdown`} />
            <div className="px-4 pb-4 pt-3 space-y-3">
              {(() => {
                const colors = ['#6366f1','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#ec4899','#14b8a6','#3b82f6','#84cc16']
                const maxV = sectorDist[0]?.value || 1
                return sectorDist.map((d: any, i: number) => {
                  const sources: { name: string; value: number }[] = Array.isArray(d.sources) ? d.sources : []
                  return (
                    <div key={d.name} className="space-y-1">
                      <div className="flex items-center gap-3 text-xs">
                        <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: colors[i % colors.length] }} />
                        <span className="flex-1 font-medium text-slate-700 truncate">{d.name}</span>
                        <div className="w-20 h-2 rounded-full bg-slate-100 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width:`${(d.value/maxV)*100}%`, background: colors[i%colors.length] }} />
                        </div>
                        <span className="w-8 text-right font-semibold text-slate-700">{d.value}</span>
                      </div>
                      {sources.length > 0 && (
                        <div className="ml-6 flex flex-wrap gap-1.5">
                          {sources.map((src) => (
                            <span
                              key={src.name}
                              className="rounded-full border border-sky-100 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-700"
                            >
                              {src.name}: {src.value}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })
              })()}
            </div>
          </SCard>
        </div>
      </>
    ),

    // s_state_dist: (
    //   <>
    //     <Section idx="03" title="State-wise Distribution" />
    //     <SCard>
    //       <SCardHead title="Customers by State" sub="Top 15 states — click a bar to filter" />
    //       <div className="p-4">
    //         <ResponsiveContainer width="100%" height={300}>
    //           <BarChart data={stateDist} layout="vertical" margin={{ top:2, right:56, left:4, bottom:2 }}>
    //             <CartesianGrid {...CGRID} horizontal={false} />
    //             <XAxis type="number" {...AXIS_X} tickFormatter={fmtN} />
    //             <YAxis type="category" dataKey="abbr" {...AXIS_Y} width={36} />
    //             <Tooltip content={<ChartTip />}
    //               formatter={(v: any, _n: string, p: any) => [fmtN(v), p.payload?.state || '']} />
    //             <Bar dataKey="count" name="Customers" radius={[0, 4, 4, 0]}
    //               onClick={(d: any) => setActiveState(s => s === d.state ? null : d.state)}>
    //               {stateDist.map((d, i) => (
    //                 <Cell key={d.state}
    //                   fill={activeState === d.state ? '#4338ca'
    //                     : i < 3 ? '#6366f1' : i < 6 ? '#818cf8' : i < 10 ? '#a5b4fc' : '#c7d2fe'}
    //                   className="cursor-pointer" />
    //               ))}
    //             </Bar>
    //           </BarChart>
    //         </ResponsiveContainer>
    //       </div>
    //     </SCard>
    //   </>
    // ),

    s_sector: (
      <>
        <Section idx="04" title="Sector Analysis" desc="Click any row to filter" />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Filter by State */}
          {stateTiles.length > 0 && (
            <SCard>
              <SCardHead title="Filter by State" sub="Choose a state before viewing sector analysis" />
              <div className="p-4">
                <div className="flex flex-wrap gap-1.5">
                  {stateTiles.map(t => {
                    const isActive  = activeState === t.state
                    const intensity = Math.round((t.count / maxStateTile) * 5)
                    return (
                      <button key={t.state}
                        onClick={() => setActiveState(s => s === t.state ? null : t.state)}
                        title={t.state}
                        className={`h-8 px-2.5 rounded-lg text-xs font-medium border transition-all ${
                          isActive ? 'bg-indigo-600 border-indigo-600 text-white shadow-md'
                          : intensity >= 4 ? 'bg-indigo-100 border-indigo-200 text-indigo-800 hover:bg-indigo-200'
                          : intensity >= 2 ? 'bg-indigo-50 border-indigo-100 text-indigo-700 hover:bg-indigo-100'
                          : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                        }`}>
                        {STATE_ABBR[t.state] || t.state.slice(0, 6)}
                        <span className="ml-1 opacity-60">{t.count}</span>
                      </button>
                    )
                  })}
                  {activeState && (
                    <button onClick={() => setActiveState(null)}
                      className="h-8 px-2.5 rounded-lg text-xs text-slate-500 border border-dashed border-slate-300 hover:bg-slate-100">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </SCard>
          )}

          {/* Filter by Sector */}
          {sectorChips.length > 0 && (
            <SCard>
              <SCardHead title="Filter by Sector" sub="Choose a sector to narrow the table and charts" />
              <div className="p-4">
                <div className="flex flex-wrap gap-1.5">
                  {sectorChips.map(c => {
                    const isActive = activeSector === c.sector
                    return (
                      <button key={c.sector}
                        onClick={() => setActiveSector(s => s === c.sector ? null : c.sector)}
                        className={`h-7 px-3 rounded-full text-xs font-medium border transition-all ${
                          isActive ? 'bg-violet-600 border-violet-600 text-white shadow-md'
                          : 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100'
                        }`}>
                        {c.sector}
                        <span className="ml-1 opacity-60">({c.count})</span>
                      </button>
                    )
                  })}
                  {activeSector && (
                    <button onClick={() => setActiveSector(null)}
                      className="h-7 px-3 rounded-full text-xs text-slate-500 border border-dashed border-slate-300 hover:bg-slate-100">
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </SCard>
          )}
        </div>

        <SCard className="mt-4">
          <SCardHead title={`${singular} Distribution by Sector`} sub="Potential, leads, tenders & won value per sector" />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] table-fixed text-xs">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[9%]" />
                <col className="w-[14%]" />
                <col className="w-[9%]" />
                <col className="w-[14%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-3 py-2.5 text-left font-semibold text-slate-600 whitespace-nowrap">Sector</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">{label}</th>
                  <th className="px-3 py-2.5 text-left font-semibold text-slate-600 whitespace-nowrap">Share</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">Active %</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">Potential ₹</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">{leadsLabel} ₹</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">{tendersLabel} ₹</th>
                  <th className="px-3 py-2.5 text-right font-semibold text-slate-600 whitespace-nowrap">Won ₹</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const m = new Map<string, { count:number; active:number; potential:number; lead_val:number; tender_val:number; won_val:number }>()
                  filteredRows.forEach(r => {
                    const sc = cSector(r) || 'Other'
                    if (!m.has(sc)) m.set(sc, { count:0, active:0, potential:0, lead_val:0, tender_val:0, won_val:0 })
                    const e = m.get(sc)!
                    e.count++
                    if (cStatus(r).toLowerCase() === 'active') e.active++
                    e.potential += cPotential(r)
                    e.lead_val  += num(r.lead_value || r.total_lead_value || 0)
                    e.tender_val += num(r.tender_value || r.total_tender_value || 0)
                    e.won_val   += num(r.won_value  || r.won_tender_value  || 0)
                  })
                  const rows = [...m.entries()].sort((a,b) => b[1].count - a[1].count)
                  const total = filteredRows.length || 1
                  return rows.map(([sc, v], i) => (
                    <tr key={sc} onClick={() => setActiveSector(x => x === sc ? null : sc)}
                      className={`cursor-pointer hover:bg-violet-50 transition-colors ${i%2===0?'bg-white':'bg-slate-50/40'} ${activeSector===sc?'bg-violet-50':''}`}>
                      <td className={`px-3 py-2 font-medium truncate ${activeSector===sc?'text-violet-700':'text-slate-800'}`} title={sc}>{sc}</td>
                      <td className="px-3 py-2 text-right font-bold tabular-nums text-indigo-700">{v.count}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <div className="min-w-0 flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                            <div className="h-full rounded-full bg-violet-400" style={{ width:`${(v.count/total)*100}%` }} />
                          </div>
                          <span className="w-9 shrink-0 text-right text-slate-500 text-[10px] tabular-nums">{pct(v.count,total)}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span className={v.count&&v.active/v.count>0.6?'text-emerald-600 font-medium':'text-amber-600'}>
                          {pct(v.active, v.count)}%
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold tabular-nums text-violet-700 whitespace-nowrap">{fmtRsL(v.potential)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-blue-700 whitespace-nowrap">{fmtRsL(v.lead_val)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700 whitespace-nowrap">{fmtRsL(v.tender_val)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700 font-semibold whitespace-nowrap">{fmtRsL(v.won_val)}</td>
                    </tr>
                  ))
                })()}
              </tbody>
            </table>
          </div>
        </SCard>
      </>
    ),

    s_comparison: (
      <>
        <Section idx="05" title="Comparison" desc="Compare By: State · Sector · Group · Status · User" />
        <CustomerComparisonTable rows={filteredRows} masterGroups={masterGroups} />
      </>
    ),

    s_top: (() => {
      const maxPotential = topByPotential[0]?.value || 1
      const allEqual = topByPotential.length > 1 && topByPotential.every(r => r.value === maxPotential)
      return (
        <>
          <Section idx="06" title="Top Accounts — Highest Potential Value" />
          <SCard>
            <SCardHead
              title={`Top 10 ${label} by Potential`}
              sub={allEqual
                ? `All accounts have the same potential value (${fmtRsL(maxPotential)}) — update individual records to see ranking`
                : 'Ranked by estimated revenue opportunity'}
            />
            <div className="divide-y divide-slate-100">
              {topByPotential.length === 0
                ? <p className="text-xs text-slate-400 text-center py-8">No potential value set — edit {singularLower} records to add a potential value</p>
                : topByPotential.map((r, i) => {
                  const statusColor =
                    r.status.toLowerCase() === 'active'   ? 'bg-emerald-100 text-emerald-700' :
                    r.status.toLowerCase() === 'prospect' ? 'bg-blue-100 text-blue-700' :
                    r.status.toLowerCase() === 'churned'  ? 'bg-red-100 text-red-600' :
                    'bg-slate-100 text-slate-500'
                  const potColor =
                    r.potential.toLowerCase() === 'high'   ? 'text-rose-600' :
                    r.potential.toLowerCase() === 'medium' ? 'text-amber-600' :
                    'text-slate-400'
                  return (
                    <div key={r.name + i} className="flex items-center gap-3 px-4 py-3">
                      <span className={`flex-shrink-0 w-6 h-6 rounded-full text-[10px] font-bold flex items-center justify-center ${
                        i < 3 ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{i+1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[12px] font-semibold text-slate-800 truncate">{r.name}</span>
                          {r.status && (
                            <span className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded-full ${statusColor}`}>{r.status}</span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                          <span>{r.sector || '—'}</span>
                          <span>·</span>
                          <span>{r.state || '—'}</span>
                          {r.kam && <><span>·</span><span className="text-slate-500">KAM: {r.kam}</span></>}
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-right">
                        <div className="text-[12px] font-bold text-violet-700 tabular-nums">{fmtRsL(r.value)}</div>
                        {r.potential && (
                          <div className={`text-[9.5px] font-semibold ${potColor}`}>{r.potential} potential</div>
                        )}
                      </div>
                      <div className="w-16 h-1.5 rounded-full bg-slate-100 overflow-hidden flex-shrink-0">
                        <div className="h-full rounded-full bg-indigo-500"
                          style={{ width: allEqual ? '50%' : `${(r.value / maxPotential) * 100}%` }} />
                      </div>
                    </div>
                  )
                })
              }
            </div>
          </SCard>
        </>
      )
    })(),

    s_table: (
      <>
        <Section idx="07" title={`All ${label}${activeState ? ` — ${activeState}` : ''}${activeSector ? ` / ${activeSector}` : ''}`} />
        <DataTable rows={filteredRows} columns={cols} title={labelLower} />
      </>
    ),
  }

  return (
    <div className="space-y-4 p-6">

      {/* Active filter banner */}
      {(activeState || activeSector) && (
        <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-xl text-xs text-indigo-700">
          <Filter size={12} />
          Filtered:
          {activeState  && <span className="font-semibold bg-indigo-100 px-1.5 rounded">{activeState}</span>}
          {activeSector && <span className="font-semibold bg-violet-100 px-1.5 rounded text-violet-700">{activeSector}</span>}
          <span className="text-slate-400">({filteredRows.length} {labelLower})</span>
          <button onClick={handleReset} className="ml-auto underline hover:no-underline">Clear all</button>
        </div>
      )}

      {/* ── DRAGGABLE SECTIONS ─────────────────────────────────────────────── */}
      {order.map(id => (
        <DragSection key={id} id={id} arranging={arranging}
          onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop}>
          <div className="space-y-3">{sectionMap[id]}</div>
        </DragSection>
      ))}
    </div>
  )
}
