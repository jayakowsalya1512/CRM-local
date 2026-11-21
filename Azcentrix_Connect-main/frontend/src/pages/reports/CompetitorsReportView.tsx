/**
 * CompetitorsReportView.tsx — Competitive Intelligence report (Reports section).
 * Data source: GET /reports/competitors (reports_router.py) — competitor master enriched
 * with tender loss analysis (loss counts, L1 wins, loss value).
 *
 * Layout is intentionally DIFFERENT from every other module dashboard: a threat-intelligence
 * battle-board — threat-level donut + loss-impact ranking, rich per-competitor battle cards
 * (strengths / weaknesses / OEM partnerships / strong regions), regional coverage and an
 * L1-winners board. All computed client-side from the rows.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { PieChart, Pie, Cell, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import api from '@/services/api'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  C, CHART, fmtN, fmtRsL, num, pct, ChartTip, Badge, ChartShell, StatsRow, TopList,
  Section, TabSkeleton, ColDef, AXIS_X, AXIS_Y, CGRID, Tooltip, ResponsiveContainer, exportRows,
} from '../dashboard/tabs/_shared'
import { DataTable } from '@/components/ui/DataTable'
import { InsightCard, InsightItem } from '../dashboard/tabs/InsightCard'
import { AnalyticsFilterBar, AnalyticsFilterState, EMPTY_ANALYTICS_FILTERS } from './shared/AnalyticsFilterBar'
import { ListDrilldownModal, ListDrilldownRequest } from './shared/ListDrilldownModal'
import { useGlobalDateRangeSync, useInitialGlobalDateRange } from './shared/useGlobalDateRangeSync'

// Server-side filters supported by GET /reports/competitors; the bar's Status select maps
// to threat_level and Region to country. Search stays client-side.
function toBackendParams(f: AnalyticsFilterState) {
  const p = new URLSearchParams()
  if (f.date_from) p.set('date_from', f.date_from)
  if (f.date_to) p.set('date_to', f.date_to)
  if (f.status) p.set('threat_level', f.status)
  if (f.region) p.set('country', f.region)
  return p
}
const SERVER_KEYS: (keyof AnalyticsFilterState)[] = ['date_from', 'date_to', 'status', 'region']

const THREAT_COLOR: Record<string, string> = { High: C.neg, Medium: C.warn, Low: C.pos, Unknown: C.ink4 }
const THREAT_TONE: Record<string, 'neg' | 'warn' | 'pos' | 'neutral'> = { High: 'neg', Medium: 'warn', Low: 'pos' }

function ChipList({ raw, tone }: { raw: string; tone: 'info' | 'neutral' }) {
  const items = (raw || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4)
  if (!items.length) return <span className="text-[11px] text-slate-300">—</span>
  return (
    <span className="flex flex-wrap gap-1">
      {items.map(it => <Badge key={it} text={it} tone={tone} dot={false} />)}
    </span>
  )
}

export default function CompetitorsReportView() {
  const {
    label: competitorsLabel,
    singular: competitorsSingular,
    labelLower: competitorsLabelLower,
    singularLower: competitorsSingularLower,
  } = useModuleName('competitors')
  const { singular: tendersSingular, labelLower: tendersLabelLower, singularLower: tendersSingularLower } = useModuleName('tenders')
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const initialGlobalRange = useInitialGlobalDateRange()
  const [filters, setFilters] = useState<AnalyticsFilterState>(() => ({ ...EMPTY_ANALYTICS_FILTERS, ...initialGlobalRange }))
  const [listDrill, setListDrill] = useState<ListDrilldownRequest | null>(null)

  const loadData = useCallback(async (f: AnalyticsFilterState) => {
    setLoading(true)
    try {
      const res = await api.get(`/reports/competitors?${toBackendParams(f)}`)
      setRows(res.data?.data || [])
    } catch { setRows([]) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadData(filters) }, [loadData]) // eslint-disable-line react-hooks/exhaustive-deps -- runs once on mount with the (possibly toolbar-seeded) initial filters

  const handleChange = (k: keyof AnalyticsFilterState, v: string) => {
    const next = { ...filters, [k]: v }
    setFilters(next)
    if (SERVER_KEYS.includes(k)) loadData(next)
  }

  useGlobalDateRangeSync((date_from, date_to) => {
    const next = { ...filters, date_from, date_to }
    setFilters(next)
    loadData(next)
  })

  const handleReset = () => {
    setFilters(EMPTY_ANALYTICS_FILTERS)
    loadData(EMPTY_ANALYTICS_FILTERS)
  }

  const tableRows = useMemo(() => {
    if (!filters.search) return rows
    const q = filters.search.toLowerCase()
    return rows.filter(r => Object.values(r).some(v => String(v ?? '').toLowerCase().includes(q)))
  }, [rows, filters.search])

  const threatSplit = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      const t = r.threat_level || 'Unknown'
      m[t] = (m[t] || 0) + 1
    })
    return Object.entries(m).map(([name, value]) => ({ name, value, fill: THREAT_COLOR[name] || C.ink4 }))
      .sort((a, b) => b.value - a.value)
  }, [tableRows])

  const lossImpact = useMemo(() =>
    [...tableRows].filter(r => num(r.total_loss_value) > 0 || num(r.tender_loss_count) > 0)
      .sort((a, b) => num(b.total_loss_value) - num(a.total_loss_value))
      .slice(0, 8)
      .map(r => ({ name: r.name, value: num(r.total_loss_value), losses: num(r.tender_loss_count) })), [tableRows])

  const battleCards = useMemo(() =>
    [...tableRows].sort((a, b) => {
      const threatRank = (t: string) => t === 'High' ? 0 : t === 'Medium' ? 1 : 2
      const tr = threatRank(a.threat_level || '') - threatRank(b.threat_level || '')
      return tr !== 0 ? tr : num(b.total_loss_value) - num(a.total_loss_value)
    }).slice(0, 4), [tableRows])

  const regionCoverage = useMemo(() => {
    const m: Record<string, number> = {}
    tableRows.forEach(r => {
      (r.strong_regions || '').split(',').map((s: string) => s.trim()).filter(Boolean)
        .forEach((region: string) => { m[region] = (m[region] || 0) + 1 })
    })
    return Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
  }, [tableRows])

  const l1Winners = useMemo(() =>
    [...tableRows].filter(r => num(r.l1_count) > 0).sort((a, b) => num(b.l1_count) - num(a.l1_count)), [tableRows])

  // Rows of competitors whose strong_regions list includes the given region — shared by the
  // "Regional Contention" rows and the "Most contested region" insight so both drilldowns match.
  const rowsForRegion = useCallback(
    (region: string) =>
      tableRows.filter(r =>
        (r.strong_regions || '').split(',').map((s: string) => s.trim()).filter(Boolean).includes(region),
      ),
    [tableRows],
  )

  const insights: (InsightItem & { rows: any[] })[] = useMemo(() => {
    const items: (InsightItem & { rows: any[] })[] = []
    const biggest = lossImpact[0]
    const biggestRow = biggest ? tableRows.find(r => r.name === biggest.name) : undefined
    items.push({
      title: `Highest losing ${competitorsSingularLower}`, tone: biggest ? 'neg' : 'pos',
      detail: biggest ? `${biggest.name} — ${fmtN(biggest.losses)} ${tendersLabelLower} lost to them` : `No recorded ${tendersSingularLower} losses in this period`,
      value: biggest ? fmtRsL(biggest.value) : undefined,
      rows: biggestRow ? [biggestRow] : [],
    })
    const highThreatQuiet = tableRows.filter(r => (r.threat_level || '') === 'High' && num(r.tender_loss_count) === 0)
    items.push({
      title: 'High threat, no data', tone: highThreatQuiet.length ? 'warn' : 'pos',
      detail: `High-threat ${competitorsLabelLower} with no loss analysis recorded — intelligence gap`,
      value: fmtN(highThreatQuiet.length),
      rows: highThreatQuiet,
    })
    const topRegion = regionCoverage[0]
    if (topRegion) items.push({
      title: 'Most contested region', tone: 'info',
      detail: `${topRegion.name} has the densest ${competitorsSingularLower} presence`,
      value: fmtN(topRegion.count),
      rows: rowsForRegion(topRegion.name),
    })
    return items
  }, [lossImpact, tableRows, regionCoverage, rowsForRegion, competitorsSingularLower, competitorsLabelLower, tendersLabelLower, tendersSingularLower])

  const cols: ColDef[] = [
    { key: 'name', label: competitorsSingular, render: v => <span className="font-semibold text-slate-900">{v || '—'}</span> },
    { key: 'threat_level', label: 'Threat', render: v => v ? <Badge text={v} tone={THREAT_TONE[v] || 'neutral'} /> : <span className="text-slate-300">—</span> },
    { key: 'country', label: 'Country' },
    { key: 'state', label: 'State' },
    { key: 'tender_loss_count', label: 'Losses To', align: 'right' },
    { key: 'l1_count', label: 'L1 Wins', align: 'right' },
    { key: 'total_loss_value', label: 'Loss Value ₹', money: true, align: 'right' },
    { key: 'oem_partnerships', label: 'OEM Partners', render: v => <span className="text-[11px] text-slate-500 truncate max-w-[160px] block">{v || '—'}</span> },
    { key: 'strong_regions', label: 'Strong Regions', render: v => <span className="text-[11px] text-slate-500 truncate max-w-[160px] block">{v || '—'}</span> },
  ]

  const openList = (title: string, sub: string, list: any[]) => {
    setListDrill({ title, sub, rows: list, columns: cols })
  }

  if (loading && !rows.length) return <TabSkeleton />

  return (
    <div className="space-y-5">
 

      <AnalyticsFilterBar
        filters={filters} onChange={handleChange} onReset={handleReset}
        onRefresh={() => loadData(filters)}
        onExport={() => exportRows(tableRows, cols, 'competitors')}
        filterOptions={{
          statuses: ['High', 'Medium', 'Low'],
          regions: Array.from(new Set(rows.map(r => r.country).filter(Boolean))) as string[],
        }}
        loading={loading}
      />

      {/* Hero — threat donut + loss impact ranking */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <ChartShell title="Threat Level Split" sub="Competitor master by assessed threat" height={300}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={threatSplit} dataKey="value" nameKey="name" cx="50%" cy="46%"
                innerRadius="42%" outerRadius="66%" paddingAngle={3} strokeWidth={0}>
                {threatSplit.map((d, i) => (
                  <Cell
                    key={i}
                    fill={d.fill}
                    style={{ cursor: 'pointer' }}
                    onClick={() =>
                      openList(
                        `${d.name} Threat`,
                        'Competitors at this threat level',
                        tableRows.filter(r => (r.threat_level || 'Unknown') === d.name),
                      )
                    }
                  />
                ))}
              </Pie>
              <Tooltip content={<ChartTip />} />
              <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize: 10 }} formatter={v => <span style={{ color: C.ink3 }}>{v}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </ChartShell>

        <ChartShell title="Tender Loss Impact" sub="Value lost to each competitor (loss analysis records)" height={300}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={lossImpact} layout="vertical" barSize={16} margin={{ top: 4, right: 16, bottom: 4, left: 90 }}>
              <CartesianGrid {...CGRID} horizontal={false} vertical />
              <XAxis type="number" tick={AXIS_Y} axisLine={{ stroke: '#d4dae3' }} tickLine={false}
                tickFormatter={v => v >= 1e7 ? `${(v / 1e7).toFixed(0)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(0)}L` : `${v}`} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={false} tickLine={false} width={86} />
              <Tooltip content={<ChartTip money />} />
              <Bar
                dataKey="value"
                name="Loss Value"
                fill={C.neg}
                radius={[0, 4, 4, 0]}
                style={{ cursor: 'pointer' }}
                onClick={(data: any) =>
                  openList(
                    data?.name,
                    'Loss analysis records for this competitor',
                    tableRows.filter(r => r.name === data?.name),
                  )
                }
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartShell>
      </div>

      {/* Battle cards — top-threat competitors head-to-head */}
      <Section idx="02" title="Battle Cards" desc="Highest-threat competitors — strengths, weaknesses and alliances" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {battleCards.length ? battleCards.map(comp => (
          <div
            key={comp.id}
            onClick={() => openList(comp.name, 'Competitor record', [comp])}
            className="flex cursor-pointer flex-col gap-2.5 rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)] transition hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgba(15,23,42,0.09)]"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="text-[13.5px] font-bold text-slate-900">{comp.name}</div>
              {comp.threat_level && <Badge text={comp.threat_level} tone={THREAT_TONE[comp.threat_level] || 'neutral'} />}
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-2">
                <div className="text-[16px] font-bold tabular-nums text-red-600">{fmtN(num(comp.l1_count))}</div>
                <div className="text-[9.5px] font-bold uppercase tracking-wide text-slate-400">L1 wins</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-2">
                <div className="text-[14px] font-bold tabular-nums text-slate-900">{fmtRsL(num(comp.total_loss_value))}</div>
                <div className="text-[9.5px] font-bold uppercase tracking-wide text-slate-400">lost to them</div>
              </div>
            </div>
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wide text-emerald-600">Strengths</div>
              <div className="mt-0.5 text-[11px] leading-snug text-slate-600 line-clamp-2">{comp.strengths || '—'}</div>
            </div>
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wide text-red-500">Weaknesses</div>
              <div className="mt-0.5 text-[11px] leading-snug text-slate-600 line-clamp-2">{comp.weaknesses || '—'}</div>
            </div>
            <div>
              <div className="mb-1 text-[9.5px] font-bold uppercase tracking-wide text-slate-400">OEM partners</div>
              <ChipList raw={comp.oem_partnerships} tone="info" />
            </div>
            <div>
              <div className="mb-1 text-[9.5px] font-bold uppercase tracking-wide text-slate-400">Strong regions</div>
              <ChipList raw={comp.strong_regions} tone="neutral" />
            </div>
          </div>
        )) : (
          <div className="col-span-full rounded-2xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">
            No competitors on record for the selected filters
          </div>
        )}
      </div>

      {/* Coverage + L1 board + insights */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="rounded-2xl border border-[#e6eaf1] bg-white p-4 shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
          <div className="mb-1 text-[13px] font-semibold tracking-tight text-slate-900">Regional Contention</div>
          <div className="mb-2 text-[11px] text-slate-500">Competitor presence by strong region</div>
          {regionCoverage.length ? regionCoverage.slice(0, 6).map((r, i) => (
            <div
              key={r.name}
              onClick={() =>
                openList(r.name, 'Competitors with a strong presence in this region', rowsForRegion(r.name))
              }
              className="cursor-pointer rounded-lg transition hover:bg-slate-50"
            >
              <StatsRow label={r.name} value={fmtN(r.count)} pctVal={pct(r.count, tableRows.length || 1)} color={CHART[i % CHART.length]} />
            </div>
          )) : <div className="py-6 text-center text-xs text-slate-400">No region data recorded</div>}
        </div>
        <TopList
          title="L1 Winners Board"
          sub="Competitors most often quoted as L1"
          items={l1Winners.slice(0, 8)}
          nameKey="name"
          valueKey="l1_count"
          accentColor={C.neg}
          onItemClick={(item) =>
            openList(item.name, 'Competitors most often quoted as L1', tableRows.filter(r => r.name === item.name))
          }
        />
        <div className="grid grid-cols-1 gap-3">
          {insights.map((it, i) => (
            <InsightCard key={i} item={it} onClick={it.rows.length ? () => openList(it.title, it.detail, it.rows) : undefined} />
          ))}
        </div>
      </div>

      <Section idx="03" title="Competitor Register" desc="Complete competitor master with loss intelligence" />
      <DataTable data={tableRows} columns={cols as any} title="competitors" showExport showColumnToggle />

      <ListDrilldownModal
        request={listDrill}
        onClose={() => setListDrill(null)}
      />
    </div>
  )
}
