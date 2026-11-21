import type { ReactNode } from 'react'
import { Activity, BarChart2, FileText, Target, TrendingUp } from 'lucide-react'
import { useModuleName } from '@/context/ModuleLabelsContext'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const C = {
  ink: '#0b1220', ink2: '#334155', ink3: '#64748b', ink4: '#94a3b8',
  border: '#e2e8f0', primary: '#1e40af', pos: '#059669',
  neg: '#dc2626', warn: '#d97706', info: '#0284c7', teal: '#0d9488',
} as const

const CHART_COLORS = ['#1e40af','#7c3aed','#ea580c','#059669','#dc2626','#0d9488','#d97706','#64748b']

const num = (v: any): number => Number(v) || 0
const hasMetric = (v: any): boolean => v !== undefined && v !== null && v !== ''
const metric = (...values: any[]): number => {
  const value = values.find(hasMetric)
  return value === undefined ? 0 : num(value)
}
const fmtN = (n: number) => (n ?? 0).toLocaleString('en-IN')
const fmtRsL = (n: number) => {
  if (!n) return '₹ 0'
  if (n >= 1e7) return `₹ ${(n / 1e7).toFixed(2)} Cr`
  if (n >= 1e5) return `₹ ${(n / 1e5).toFixed(2)} L`
  return `₹ ${fmtN(Math.round(n))}`
}
const fmtRsCr = (n: number) => {
  if (!n) return '0'
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)} L`
  return fmtN(Math.round(n))
}

function Card({ children, className = '', accent }: { children: ReactNode; className?: string; accent?: string }) {
  return (
    <div className={`flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm transition-all hover:shadow-md ${className}`}>
      {accent && <span className="block h-[3px] w-full flex-shrink-0" style={{ background: `linear-gradient(90deg, ${accent}, ${accent}44)` }} />}
      {children}
    </div>
  )
}

function CardHead({
  title, sub, action, accent, icon,
}: { title: string; sub?: string; action?: ReactNode; accent?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-shrink-0 items-start justify-between gap-3 px-5 pb-2 pt-4">
      <div className="flex items-center gap-3">
        {icon && accent && (
          <span
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: `${accent}18`, color: accent }}
          >
            {icon}
          </span>
        )}
        <div>
          <div className="text-[13px] font-bold text-slate-900">{title}</div>
          {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
        </div>
      </div>
      {action}
    </div>
  )
}

function Empty({ label, icon }: { label: string; icon?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-slate-400">
      {icon}
      <span>{label}</span>
    </div>
  )
}

const ChartTip = ({ active, payload, label, money }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 shadow-xl">
      {label && <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color || p.fill }} />
          <span className="text-slate-500">{p.name}:</span>
          <span className="ml-auto font-bold tabular-nums">{money ? fmtRsL(p.value) : (p.value ?? 0).toLocaleString('en-IN')}</span>
        </div>
      ))}
    </div>
  )
}

function PipelineValueDonut({ data }: { data: any }) {
  const { label: leadsLabel } = useModuleName('leads')
  const { label: oppLabel } = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: emdbgLabel } = useModuleName('emdbg')
  const ov = data?.overview || {}
  const values = {
    Leads: metric(ov.lead_value),
    Opportunities: metric(ov.opportunity_value),
    Tenders: metric(ov.tender_value, ov.pipeline_value),
    Won: num(ov.won_value),
    'EMD / BG': metric(ov.emdbg_value, ov.active_emdbg_value),
  }
  const chartData = [{ name: 'Pipeline Value', ...values }]
  const total = Object.values(values).reduce((s, v) => s + v, 0)
  const segments = [
    { key:'Leads', display: leadsLabel, color:'#2563eb' }, { key:'Opportunities', display: oppLabel, color:'#7c3aed' },
    { key:'Tenders', display: tenderLabel, color:'#f97316' }, { key:'Won', display: 'Won', color:'#059669' }, { key:'EMD / BG', display: emdbgLabel, color:'#dc2626' },
  ]

  return (
    <Card accent="#7c3aed">
      <CardHead title="Pipeline Value" sub="₹ distribution by stage" accent="#7c3aed" icon={<TrendingUp size={14}/>} />
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-1">
        <div className="mb-4 grid grid-cols-3 gap-2">
          {[
            { label:'Total Value', val:fmtRsL(total) },
            { label:'Highest Stage', val:segments.reduce((a,b)=>(values[b.key as keyof typeof values]>values[a.key as keyof typeof values]?b:a)).display },
            { label:'Stages', val:String(segments.length) },
          ].map((s)=>(
            <div key={s.label} className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2.5">
              <div className="text-[10px] font-semibold text-slate-500">{s.label}</div>
              <div className="mt-0.5 truncate text-[15px] font-extrabold text-slate-900">{s.val}</div>
            </div>
          ))}
        </div>
        <div className="h-[140px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top:12, right:12, left:12, bottom:6 }}>
              <CartesianGrid strokeDasharray="2 3" stroke="#e6eaf1" horizontal={false} />
              <XAxis type="number" tickFormatter={(v)=>fmtRsCr(Number(v))} tick={{ fontSize:10, fill:C.ink4 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" hide />
              <Tooltip content={<ChartTip money />} />
              {segments.map((s)=>(
                <Bar key={s.key} dataKey={s.key} name={s.display} stackId="value" fill={s.color} radius={[6,6,6,6]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 grid grid-cols-5 gap-1.5">
          {segments.map((s) => {
            const v = values[s.key as keyof typeof values]
            const p = total ? Math.round((v/total)*100) : 0
            return (
              <div key={s.key} className="rounded-lg border border-slate-100 bg-white p-2">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background:s.color }} />
                  <span className="truncate text-[10px] font-semibold text-slate-600">{s.display}</span>
                </div>
                <div className="text-[11px] font-extrabold text-slate-900">{fmtRsL(v)}</div>
                <div className="mt-0.5 text-[10px] text-slate-400">{p}%</div>
              </div>
            )
          })}
        </div>
      </div>
    </Card>
  )
}

function LeadTrendChart({ data }: { data: any }) {
  const { label: leadsLabel, singular: leadSingular, labelLower: leadsLower } = useModuleName('leads')
  const mt = data?.monthly_trend || []
  return (
    <Card accent="#1e40af">
      <CardHead title={`${leadSingular} Trend`} sub={`New ${leadsLower} per month`} accent="#1e40af" icon={<Activity size={14}/>} />
      <div className="min-h-0 flex-1 px-3 pb-4 pt-1">
        {mt.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={mt} margin={{ top:8, right:16, bottom:0, left:-10 }}>
              <defs>
                <linearGradient id="leadAreaFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={C.primary} stopOpacity={0.18} />
                  <stop offset="100%" stopColor={C.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="2 3" stroke="#e6eaf1" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize:10, fill:C.ink4 }} axisLine={{ stroke:'#d4dae3' }} tickLine={false} />
              <YAxis tick={{ fontSize:10, fill:C.ink4 }} axisLine={false} tickLine={false} width={28} />
              <Tooltip content={<ChartTip />} />
              <Area type="monotone" dataKey="leads" name={leadsLabel} stroke={C.primary} strokeWidth={2.5}
                fill="url(#leadAreaFill)"
                dot={{ r:3, fill:'#fff', stroke:C.primary, strokeWidth:2 }}
                activeDot={{ r:5, fill:C.primary, stroke:'#fff', strokeWidth:2 }} />
            </AreaChart>
          </ResponsiveContainer>
        ) : <Empty label="No data yet" />}
      </div>
    </Card>
  )
}

function LeadStatusChart({ data }: { data: any }) {
  const { label: leadsLabel, singularLower: leadLower } = useModuleName('leads')
  const lbs = data?.lead_by_status || []
  const STATUS_COLORS: Record<string, string> = {
    Assigned:'#6366f1', Qualified:'#4338ca', 'Opportunity Created':C.info,
    Converted:C.pos, Lost:C.neg, Won:C.pos, Pending:C.warn, Cancelled:C.ink4,
  }
  return (
    <Card accent="#6366f1">
      <CardHead title={`${leadsLabel} by Status`} sub="Pipeline composition" accent="#6366f1" icon={<Target size={14}/>} />
      <div className="min-h-0 flex-1 px-2 pb-3">
        {lbs.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={lbs} dataKey="count" nameKey="status" cx="50%" cy="45%"
                innerRadius="46%" outerRadius="66%" paddingAngle={2} strokeWidth={0}>
                {lbs.map((item: any, i: number) => (
                  <Cell key={i} fill={STATUS_COLORS[item.status] || CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip content={<ChartTip />} />
              <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize:10, paddingTop:4 }}
                formatter={(v)=><span style={{ color:C.ink3 }}>{v}</span>} />
            </PieChart>
          </ResponsiveContainer>
        ) : <Empty label={`No ${leadLower} data`} />}
      </div>
    </Card>
  )
}

function TenderResultChart({ data }: { data: any }) {
  const { singular: tenderSingular, singularLower: tenderLower } = useModuleName('tenders')
  const tbr = data?.tender_by_result || []
  return (
    <Card accent="#7c3aed">
      <CardHead title={`${tenderSingular} Outcomes`} sub="Win / Loss / Pending" accent="#7c3aed" icon={<FileText size={14}/>} />
      <div className="min-h-0 flex-1 px-3 pb-4 pt-1">
        {tbr.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={tbr} barSize={32} margin={{ top:16, right:8, bottom:0, left:-10 }}>
              <CartesianGrid strokeDasharray="2 3" stroke="#e6eaf1" vertical={false} />
              <XAxis dataKey="result" tick={{ fontSize:10, fill:C.ink3 }} axisLine={{ stroke:'#d4dae3' }} tickLine={false} />
              <YAxis tick={{ fontSize:10, fill:C.ink4 }} axisLine={false} tickLine={false} width={28} />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="count" name="Count" radius={[5,5,0,0]}>
                {tbr.map((r: any, i: number) => (
                  <Cell key={i}
                    fill={r.result==='Won' ? C.pos : r.result==='Lost' ? '#fca5a5' : r.result==='Pending' ? '#fcd34d' : C.ink4} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : <Empty label={`No ${tenderLower} data`} />}
      </div>
    </Card>
  )
}

function LeadSourceMix() {
  const { singular: leadSingular, labelLower: leadsLower } = useModuleName('leads')
  const sourceData = [
    { name:'Direct', value:34 }, { name:'Referral', value:22 },
    { name:'Web', value:18 }, { name:'Campaign', value:15 }, { name:'Other', value:11 },
  ]
  return (
    <Card accent="#d97706">
      <CardHead title={`${leadSingular} Source Mix`} sub={`Where ${leadsLower} come from`} accent="#d97706" icon={<BarChart2 size={14}/>} />
      <div className="min-h-0 flex-1 px-2 pb-3">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={sourceData} dataKey="value" nameKey="name" cx="50%" cy="45%"
              innerRadius="46%" outerRadius="66%" paddingAngle={2} strokeWidth={0}>
              {sourceData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip content={<ChartTip />} />
            <Legend iconSize={8} iconType="square" wrapperStyle={{ fontSize:10 }}
              formatter={(v)=><span style={{ color:C.ink3 }}>{v}</span>} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

export default function OverviewChartWidget({ id, data }: { id: string; data: any }) {
  switch (id) {
    case 'chart_lead_trend': return <LeadTrendChart data={data} />
    case 'chart_pipeline_value': return <PipelineValueDonut data={data} />
    case 'chart_lead_status': return <LeadStatusChart data={data} />
    case 'chart_tender_result': return <TenderResultChart data={data} />
    case 'chart_lead_source': return <LeadSourceMix />
    default: return null
  }
}
