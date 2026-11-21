/**
 * _analyticsCharts.tsx — additional chart-type wrappers for the Reports analytics tabs
 * (funnel, treemap, heatmap, gauge, timeline, stacked-bar). Additive to _shared.tsx.
 */
import {
  FunnelChart, Funnel, LabelList, Treemap, RadialBarChart, RadialBar, PolarAngleAxis,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell,
} from 'recharts'
import {
  Tooltip, ResponsiveContainer, ChartShell, C, CHART, fmtN, fmtRsL, pct, num, ChartTip,
  Badge, Tone, AXIS_X, AXIS_Y, CGRID,
} from './_shared'

// ─── Pipeline Conversion Card (3×2 snake grid) ────────────────────────────────
const PIPE_COLORS = ['#4338ca', '#0284c7', '#0891b2', '#059669', '#65a30d', '#d97706']

function _convColor(cv: number) {
  return cv >= 50 ? '#059669' : cv >= 25 ? '#d97706' : '#dc2626'
}

function _StageCard({ name, value, index, sharePct, onClick }: {
  name: string; value: number; index: number; sharePct: number; onClick?: () => void
}) {
  const color = PIPE_COLORS[index % PIPE_COLORS.length]
  return (
    <div
      onClick={onClick}
      className={`flex flex-1 flex-col rounded-xl border px-2.5 py-2 ${onClick ? 'cursor-pointer transition hover:brightness-95' : ''}`}
      style={{ background: `${color}08`, borderColor: `${color}25` }}
    >
      <div className="flex items-center gap-1 mb-1">
        <div className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="text-[7.5px] font-bold uppercase tracking-wide" style={{ color: `${color}bb` }}>
          Step {index + 1}
        </span>
      </div>
      <div className="text-[9px] font-semibold leading-tight text-slate-600">{name}</div>
      <div className="mt-auto pt-1.5 text-[21px] font-extrabold tabular-nums leading-none" style={{ color }}>
        {value}
      </div>
      <div className="mt-0.5 text-[7.5px] font-medium text-slate-400">{sharePct}% of total</div>
    </div>
  )
}

function _Arrow({ cv, dir }: { cv: number; dir: '→' | '←' | '↓' }) {
  const col = _convColor(cv)
  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 self-center px-0.5">
      <span className="text-[11px] font-bold leading-none" style={{ color: col }}>{dir}</span>
      <span className="text-[7px] font-bold tabular-nums" style={{ color: col }}>{cv}%</span>
    </div>
  )
}

export function PipelineConversionCard({ title, sub, data, height = 260, onStageClick }: {
  title: string; sub?: string
  data: { name: string; value: number }[]
  height?: number
  onStageClick?: (stage: { name: string; value: number }, index: number) => void
}) {
  const max = Math.max(data[0]?.value ?? 1, 1)

  if (!data.length) return (
    <ChartShell title={title} sub={sub} height={height}>
      <div className="flex h-full items-center justify-center text-xs text-slate-400">No data</div>
    </ChartShell>
  )

  const cv = (i: number) => i === 0 ? 100 : pct(data[i].value, data[i - 1].value)
  const share = (i: number) => pct(data[i].value, max)

  const row1 = data.slice(0, 3)
  const row2 = [...data.slice(3)].reverse()   // display right-to-left: stage5, stage4, stage3

  return (
    <ChartShell title={title} sub={sub} height={height}>
      <div className="flex h-full flex-col gap-1.5 py-0.5">

        {/* Row 1: stage0 → stage1 → stage2 */}
        <div className="flex flex-1 items-stretch gap-1">
          {row1.map((stage, j) => (
            <div key={j} className="flex flex-1 items-stretch gap-1 min-w-0">
              {j > 0 && <_Arrow cv={cv(j)} dir="→" />}
              <_StageCard
                name={stage.name}
                value={stage.value}
                index={j}
                sharePct={share(j)}
                onClick={onStageClick ? () => onStageClick(stage, j) : undefined}
              />
            </div>
          ))}
        </div>

        {/* Down connector aligned to the right card */}
        {row2.length > 0 && (
          <div className="flex justify-end" style={{ paddingRight: 0 }}>
            <div className="flex items-center justify-center" style={{ width: 'calc(33.33% - 4px)' }}>
              <_Arrow cv={cv(3)} dir="↓" />
            </div>
          </div>
        )}

        {/* Row 2: stage5 ← stage4 ← stage3 (snake right-to-left) */}
        {row2.length > 0 && (
          <div className="flex flex-1 items-stretch gap-1">
            {row2.map((stage, j) => {
              const pipeIdx = data.length - 1 - j        // 5, 4, 3
              const arrowCv = j === 0 ? null : cv(pipeIdx + 1)  // conv of stage that feeds into prev display card
              return (
                <div key={j} className="flex flex-1 items-stretch gap-1 min-w-0">
                  {j > 0 && arrowCv !== null && <_Arrow cv={arrowCv} dir="←" />}
                  <_StageCard
                    name={stage.name}
                    value={stage.value}
                    index={pipeIdx}
                    sharePct={share(pipeIdx)}
                    onClick={onStageClick ? () => onStageClick(stage, pipeIdx) : undefined}
                  />
                </div>
              )
            })}
          </div>
        )}

      </div>
    </ChartShell>
  )
}

// ─── Funnel (legacy — kept for other report views) ────────────────────────────
export function FunnelCard({ title, sub, data, money, height = 260 }: {
  title: string; sub?: string
  data: { name: string; value: number }[]
  money?: boolean; height?: number
}) {
  const colored = data.map((d, i) => ({ ...d, fill: CHART[i % CHART.length] }))
  return (
    <ChartShell title={title} sub={sub} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <FunnelChart>
          <Tooltip content={<ChartTip money={money} />} />
          <Funnel dataKey="value" data={colored} isAnimationActive nameKey="name">
            {colored.map((d, i) => <Cell key={i} fill={d.fill} />)}
            <LabelList position="right" fill={C.ink2} stroke="none" dataKey="name" fontSize={10} />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    </ChartShell>
  )
}

// ─── Treemap ──────────────────────────────────────────────────────────────────
function TreemapCell(props: any) {
  const { x, y, width, height, name, value, index } = props
  if (width < 2 || height < 2) return null
  const fill = CHART[(index ?? 0) % CHART.length]
  const showLabel = width > 44 && height > 26
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} fillOpacity={0.88} stroke="#fff" strokeWidth={2} rx={4} />
      {showLabel && (
        <>
          <text x={x + 8} y={y + 16} fontSize={10} fontWeight={700} fill="#fff" className="pointer-events-none">
            {String(name).length > Math.floor(width / 6) ? `${String(name).slice(0, Math.floor(width / 6))}…` : name}
          </text>
          <text x={x + 8} y={y + 30} fontSize={9.5} fill="rgba(255,255,255,0.85)" className="pointer-events-none">
            {fmtRsL(value)}
          </text>
        </>
      )}
    </g>
  )
}

export function TreemapCard({ title, sub, data, height = 260 }: {
  title: string; sub?: string
  data: { name: string; value: number }[]
  height?: number
}) {
  if (!data?.length) return (
    <ChartShell title={title} sub={sub} height={height}>
      <div className="flex h-full items-center justify-center text-xs text-slate-400">No data</div>
    </ChartShell>
  )
  return (
    <ChartShell title={title} sub={sub} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <Treemap data={data} dataKey="value" nameKey="name" stroke="#fff" content={<TreemapCell />} />
      </ResponsiveContainer>
    </ChartShell>
  )
}

// ─── Heatmap (custom CSS grid — recharts has no native heatmap) ───────────────
export function HeatmapGrid({ title, sub, rows, cols, cellValue, valueFmt, height }: {
  title: string; sub?: string
  rows: string[]; cols: string[]
  cellValue: (row: string, col: string) => number
  valueFmt?: (v: number) => string
  height?: number
}) {
  const fmt = valueFmt || fmtN
  const values = rows.flatMap(r => cols.map(c => cellValue(r, c)))
  const max = Math.max(...values, 1)
  const colorFor = (v: number) => {
    if (!v) return '#f1f5f9'
    const t = Math.min(1, v / max)
    const alpha = 0.12 + t * 0.78
    return `rgba(67,56,202,${alpha.toFixed(2)})`
  }
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="px-5 pt-4 pb-3">
        <div className="text-[13px] font-semibold tracking-tight text-slate-900">{title}</div>
        {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
      </div>
      <div className="overflow-x-auto px-3 pb-4" style={height ? { maxHeight: height } : undefined}>
        <table className="w-full border-separate" style={{ borderSpacing: 3 }}>
          <thead>
            <tr>
              <th className="w-[110px]" />
              {cols.map(c => (
                <th key={c} className="px-1 pb-1 text-center text-[9.5px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r}>
                <td className="pr-2 text-[11px] font-medium text-slate-600 whitespace-nowrap text-right">{r}</td>
                {cols.map(c => {
                  const v = cellValue(r, c)
                  return (
                    <td key={c} title={`${r} · ${c}: ${fmt(v)}`}
                      className="h-8 min-w-[34px] rounded-md text-center align-middle text-[10px] font-semibold"
                      style={{ background: colorFor(v), color: v / max > 0.55 ? '#fff' : '#334155' }}>
                      {v ? fmt(v) : ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Gauge / score card ────────────────────────────────────────────────────────
export function GaugeCard({ title, sub, value, max, label, tone = 'primary', height = 220 }: {
  title: string; sub?: string; value: number; max: number; label?: string
  tone?: 'primary' | 'pos' | 'warn' | 'neg'; height?: number
}) {
  const toneColor: Record<string, string> = { primary: C.primary, pos: C.pos, warn: C.warn, neg: C.neg }
  const p = pct(value, max)
  const data = [{ name: label || title, value: p, fill: toneColor[tone] }]
  return (
    <ChartShell title={title} sub={sub} height={height}>
      <div className="relative h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="72%" outerRadius="100%" data={data}
            startAngle={180} endAngle={0} barSize={16}
            cx="50%" cy="70%"
          >
            <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
            <RadialBar background={{ fill: '#f1f5f9' }} dataKey="value" cornerRadius={8} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-6">
          <div className="text-[26px] font-bold tabular-nums text-slate-900">{p}%</div>
          {label && <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>}
        </div>
      </div>
    </ChartShell>
  )
}

// ─── Timeline (custom vertical rail — recharts has no timeline primitive) ─────
export function TimelineChart({ title, sub, items, height = 260 }: {
  title: string; sub?: string
  items: { date: string; label: string; tone?: Tone; value?: string | number }[]
  height?: number
}) {
  const sorted = [...items].sort((a, b) => (a.date || '').localeCompare(b.date || ''))
  const dot: Record<string, string> = { pos: 'bg-emerald-500', neg: 'bg-red-500', warn: 'bg-amber-500', info: 'bg-sky-500', neutral: 'bg-slate-400' }
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[#e6eaf1] bg-white shadow-[0_4px_16px_rgba(15,23,42,0.05),0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="px-5 pt-4 pb-3">
        <div className="text-[13px] font-semibold tracking-tight text-slate-900">{title}</div>
        {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
      </div>
      <div className="overflow-y-auto px-5 pb-4" style={{ height }}>
        {!sorted.length ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-400">No upcoming items</div>
        ) : (
          <div className="relative border-l border-dashed border-slate-200 pl-4">
            {sorted.map((it, i) => (
              <div key={i} className="relative pb-4 last:pb-0">
                <span className={`absolute -left-[21px] top-0.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${dot[it.tone || 'neutral']}`} />
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-slate-400">{it.date}</span>
                  {it.value != null && <Badge text={String(it.value)} tone={it.tone} dot={false} />}
                </div>
                <div className="mt-0.5 text-[12.5px] font-medium text-slate-800">{it.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Split boxes (compact 2-col stat grid) ─────────────────────────────────────
export function SplitBoxes({ items, cols = 2 }: { items: { label: string; value: React.ReactNode }[]; cols?: number }) {
  return (
    <div className={`grid gap-2.5 ${cols === 2 ? 'grid-cols-2' : 'grid-cols-4'}`}>
      {items.map((it, i) => (
        <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
          <div className="text-[9.5px] font-bold uppercase tracking-wide text-slate-400">{it.label}</div>
          <div className="mt-1.5 text-[18px] font-bold tabular-nums text-slate-900">{it.value}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Stacked bar convenience wrapper ───────────────────────────────────────────
const SHORT_MONEY = (v: number) =>
  v >= 1e7 ? `${(v / 1e7).toFixed(1)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${v}`

export function StackedBarCard({ title, sub, data, bars, height = 260, horizontal, money, onBarClick }: {
  title: string; sub?: string; data: any[]
  bars: { dataKey: string; name: string; color: string }[]
  height?: number; horizontal?: boolean; money?: boolean
  onBarClick?: (row: any, dataKey: string) => void
}) {
  return (
    <ChartShell title={title} sub={sub} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'}
          margin={horizontal ? { top: 4, right: 16, bottom: 4, left: 80 } : { top: 16, right: 8, bottom: 28, left: 4 }}>
          <CartesianGrid {...CGRID} />
          {horizontal ? (
            <>
              <XAxis type="number" tick={AXIS_Y} axisLine={{ stroke: '#d4dae3' }} tickLine={false}
                tickFormatter={money ? SHORT_MONEY : undefined} />
              <YAxis type="category" dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={false} tickLine={false} width={76} />
            </>
          ) : (
            <>
              <XAxis dataKey="name" tick={{ ...AXIS_X, fontSize: 9 }} axisLine={{ stroke: '#d4dae3' }} tickLine={false} angle={-20} textAnchor="end" height={50} interval={0} />
              <YAxis tick={AXIS_Y} axisLine={false} tickLine={false} width={money ? 44 : 28}
                tickFormatter={money ? SHORT_MONEY : undefined} />
            </>
          )}
          <Tooltip content={<ChartTip money={money} />} />
          {bars.map(b => (
            <Bar
              key={b.dataKey}
              dataKey={b.dataKey}
              name={b.name}
              stackId="s"
              fill={b.color}
              radius={[0, 0, 0, 0]}
              cursor={onBarClick ? 'pointer' : undefined}
              onClick={onBarClick ? (row: any) => onBarClick(row, b.dataKey) : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartShell>
  )
}
