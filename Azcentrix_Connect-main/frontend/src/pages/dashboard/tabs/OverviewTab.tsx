import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  BarChart2,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  FileText,
  GripVertical,
  IndentIncrease,
  LayoutDashboard,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Shield,
  Target,
  TrendingUp,
  Users,
  X,
  Zap,
} from 'lucide-react'
import { createPortal } from 'react-dom'
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
import api from '@/services/api'
import { useAuthStore } from '@/store'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useNavigate } from 'react-router-dom'

const OverviewChartWidget = lazy(() => import('./OverviewChartWidgets'))

/* ═══════════════════════════════════════════════════════════════
   TOKENS
   ═══════════════════════════════════════════════════════════════ */
const C = {
  ink: '#0b1220', ink2: '#334155', ink3: '#64748b', ink4: '#94a3b8',
  border: '#e2e8f0', primary: '#1e40af', pos: '#059669',
  neg: '#dc2626', warn: '#d97706', info: '#0284c7', teal: '#0d9488',
} as const

const CHART_COLORS = ['#1e40af','#7c3aed','#ea580c','#059669','#dc2626','#0d9488','#d97706','#64748b']

/* ═══════════════════════════════════════════════════════════════
   WIDGET REGISTRY
   ═══════════════════════════════════════════════════════════════ */
interface SectionMeta {
  id: string; category: string; label: string; description: string
  defaultW: number; defaultH: number; minW: number; maxW: number
}

const WIDGET_REGISTRY: SectionMeta[] = [
  { id:'pipeline_overview',    category:'Pipeline', label:'Pipeline Overview',     description:'Leads → Opportunities → Tenders → Work Orders → Won → EMD/BG → Customers → Approvals', defaultW:4, defaultH:3, minW:4, maxW:4 },
  { id:'chart_lead_trend',     category:'Chart',    label:'Lead Trend',            description:'Monthly lead volume trend',          defaultW:2, defaultH:5, minW:2, maxW:4 },
  { id:'chart_pipeline_value', category:'Chart',    label:'Pipeline Value',        description:'Value distribution by stage',        defaultW:2, defaultH:5, minW:2, maxW:4 },
  { id:'chart_lead_status',    category:'Chart',    label:'Leads by Status',       description:'Lead status distribution',           defaultW:2, defaultH:5, minW:2, maxW:2 },
  { id:'chart_tender_result',  category:'Chart',    label:'Tender Outcomes',       description:'Win/loss/pending result',            defaultW:2, defaultH:5, minW:2, maxW:2 },
  { id:'chart_pipeline_funnel',category:'Chart',    label:'Conversion Funnel',     description:'Stage conversion view',              defaultW:2, defaultH:5, minW:2, maxW:2 },
  { id:'chart_lead_source',    category:'Chart',    label:'Lead Source Mix',       description:'Lead source distribution',           defaultW:2, defaultH:5, minW:2, maxW:2 },
  { id:'upcoming_bids',        category:'Activity', label:'Upcoming Bid Dates',    description:'Enhanced tender bid calendar',       defaultW:2, defaultH:5, minW:2, maxW:3 },
  { id:'activity_feed',        category:'Activity', label:'Activity Feed',         description:'Recent system activity',             defaultW:2, defaultH:5, minW:2, maxW:2 },
  { id:'quick_actions',        category:'Activity', label:'Quick Actions',         description:'Shortcut actions',                   defaultW:4, defaultH:1, minW:2, maxW:4 },
]

interface WidgetLayout { id: string; w: number; h: number; order: number }

const DEFAULT_LAYOUT: WidgetLayout[] = [
  { id:'pipeline_overview', w:4, h:3, order:0 },
  { id:'chart_lead_trend', w:2, h:5, order:1 },
  { id:'chart_pipeline_value', w:2, h:5, order:2 },
  { id:'chart_tender_result', w:2, h:5, order:3 },
  { id:'chart_lead_status', w:2, h:5, order:4 },
  { id:'upcoming_bids', w:2, h:5, order:5 },
  { id:'activity_feed', w:2, h:5, order:6 },
  { id:'quick_actions', w:4, h:1, order:7 },
]

/* ═══════════════════════════════════════════════════════════════
   FORMATTERS
   ═══════════════════════════════════════════════════════════════ */
const num = (v: any): number => Number(v) || 0
const hasMetric = (v: any): boolean => v !== undefined && v !== null && v !== ''
const metric = (...values: any[]): number => {
  const value = values.find(hasMetric)
  return value === undefined ? 0 : num(value)
}
const sumMetric = (...values: any[]): number | undefined =>
  values.some(hasMetric) ? values.reduce((sum, value) => sum + num(value), 0) : undefined
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
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)

/* ═══════════════════════════════════════════════════════════════
   UI PRIMITIVES
   ═══════════════════════════════════════════════════════════════ */
type Tone = 'pos' | 'neg' | 'warn' | 'info' | 'neutral' | 'dark'
const TONE_CLS: Record<Tone, string> = {
  pos: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  neg: 'text-red-700 bg-red-50 border-red-200',
  warn: 'text-amber-700 bg-amber-50 border-amber-200',
  info: 'text-sky-700 bg-sky-50 border-sky-200',
  neutral: 'text-slate-600 bg-slate-50 border-slate-200',
  dark: 'text-white bg-slate-900 border-slate-900',
}

function Badge({ text, tone = 'neutral' }: { text: string; tone?: Tone }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${TONE_CLS[tone]}`}>
      {text}
    </span>
  )
}

function Card({ children, className = '', accent }: { children: React.ReactNode; className?: string; accent?: string }) {
  return (
    <div className={`flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm transition-all hover:shadow-md ${className}`}>
      {accent && <span className="block h-[3px] w-full flex-shrink-0" style={{ background: `linear-gradient(90deg, ${accent}, ${accent}44)` }} />}
      {children}
    </div>
  )
}

function CardHead({
  title, sub, action, accent, icon,
}: { title: string; sub?: string; action?: React.ReactNode; accent?: string; icon?: React.ReactNode }) {
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

function Empty({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-slate-400">
      {icon}
      <span>{label}</span>
    </div>
  )
}

function DeferredChartWidget({ id, data }: { id: string; data: any }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (visible) return
    const node = ref.current
    if (!node) return

    if (!('IntersectionObserver' in window)) {
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '180px 0px' },
    )

    observer.observe(node)
    return () => observer.disconnect()
  }, [visible])

  if (!visible) {
    return (
      <div
        ref={ref}
        className="h-full rounded-2xl border border-slate-200/80 bg-white shadow-sm"
      />
    )
  }

  return (
    <div ref={ref} className="h-full">
      <Suspense fallback={<div className="h-full animate-pulse rounded-2xl border border-slate-200/80 bg-white shadow-sm" />}>
        <OverviewChartWidget id={id} data={data} />
      </Suspense>
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

/* ═══════════════════════════════════════════════════════════════
   PIPELINE KPI CARDS
   ═══════════════════════════════════════════════════════════════ */
// function PipelineCard({
//   title, value, amount, accentColor, onClick, highlight = false, icon,
// }: {
//   title: string; value: string; amount: string; accentColor: string
//   onClick?: () => void; highlight?: boolean; icon: React.ReactNode
// }) {
//   return (
//     <button
//       type="button"
//       onClick={onClick}
//       className={`group relative flex min-w-0 flex-col overflow-hidden rounded-xl border text-left transition-all duration-150 hover:-translate-y-0.5 active:scale-[0.98] ${
//         highlight
//           ? 'border-emerald-300 shadow-md shadow-emerald-100/60'
//           : 'border-slate-200 shadow-sm hover:border-slate-300 hover:shadow-md'
//       }`}
//       style={{ background: `linear-gradient(145deg, ${accentColor}12 0%, #ffffff 55%)` }}
//     >
//       {/* Left accent bar */}
//       <span
//         className="absolute left-0 top-0 h-full w-[3px] rounded-r"
//         style={{ background: `linear-gradient(180deg, ${accentColor} 0%, ${accentColor}44 100%)` }}
//       />

//       {/* Ghost background icon */}
//       <span
//         className="pointer-events-none absolute right-2.5 top-2.5 flex h-10 w-10 items-center justify-center rounded-xl opacity-[0.08] group-hover:opacity-[0.13] transition-opacity"
//         style={{ background: accentColor }}
//       >
//         <span style={{ color: '#fff', display: 'flex' }}>{icon}</span>
//       </span>

//       <span className="flex min-w-0 flex-1 flex-col justify-between pl-4 pr-12 py-3">
//         <span
//           className="truncate text-[9px] font-bold uppercase tracking-widest"
//           style={{ color: accentColor }}
//         >
//           {title}
//         </span>
//         <span className="block text-[23px] font-black leading-tight tracking-tight tabular-nums text-slate-900">
//           {value}
//         </span>
//         <span className="truncate text-[10px] font-semibold tabular-nums text-slate-400">
//           {amount}
//         </span>
//       </span>
//     </button>
//   )
// }

// function PipelineOverview({ data, navigate }: { data: any; navigate: any }) {
//   const ov = data?.overview || {}
//   const workOrders = num(ov.total_work_orders) || num(ov.active_work_orders)
//   const pendingApprovals = num(ov.pending_approvals)
//   const totalApprovals = num(ov.total_approvals) || pendingApprovals

//   const cards = [
//     { key:'leads',      title:'Leads',         value:fmtN(num(ov.total_leads)||num(ov.active_leads)),                                         amount:fmtRsL(num(ov.lead_value)||num(ov.pipeline_value)*0.3),                         accent:'#1e40af', path:'/leads',            icon:<Target size={18}/> },
//     { key:'opps',       title:'Opportunities',  value:fmtN(num(ov.total_opportunities)||num(ov.total_tenders)+num(ov.active_leads)),           amount:fmtRsL(num(ov.opportunity_value)||num(ov.pipeline_value)*0.85),                 accent:'#0d9488', path:'/opportunities',    icon:<TrendingUp size={18}/> },
//     { key:'tenders',    title:'Tenders',        value:fmtN(num(ov.total_tenders)||num(ov.active_tenders)),                                    amount:fmtRsL(num(ov.tender_value)||num(ov.pipeline_value)),                           accent:'#7c3aed', path:'/tenders',          icon:<FileText size={18}/> },
//     { key:'workorders', title:'Work Orders',    value:fmtN(workOrders),                                                                       amount:fmtRsL(num(ov.work_order_value)||num(ov.won_value)),                            accent:'#ea580c', path:'/work-orders',      icon:<LayoutDashboard size={18}/> },
//     { key:'won',        title:'Won',            value:fmtN(num(ov.won_tenders)),                                                              amount:fmtRsL(num(ov.won_value)),                                                      accent:'#059669', path:'/tenders?status=won', highlight:true, icon:<CheckCircle size={18}/> },
//     { key:'emdbg',      title:'EMD / BG',       value:fmtN(num(ov.total_emdbg)||num(ov.active_emdbg)||num(ov.emdbg_count)),                  amount:fmtRsL(num(ov.emdbg_value)||num(ov.won_value)*0.28),                           accent:'#2563eb', path:'/emdbg',           icon:<Shield size={18}/> },
//     { key:'customers',  title:'Customers',      value:fmtN(num(ov.total_customers)),                                                         amount:fmtRsL(num(ov.customer_value)||num(ov.total_invoiced)||num(ov.won_value)*2.8),  accent:'#d97706', path:'/customers',        icon:<Users size={18}/> },
//     { key:'approvals',  title:'Approvals',      value:fmtN(pendingApprovals),                                                                amount:`${fmtN(totalApprovals)} total`,                                                accent:'#ef4444', path:'/approvals',        icon:<CheckCircle size={18}/> },
//   ]

//   return (
//     <div className="grid h-full grid-cols-4 grid-rows-2 gap-2.5">
//       {cards.map((c) => (
//         <PipelineCard
//           key={c.key}
//           title={c.title}
//           value={c.value}
//           amount={c.amount}
//           accentColor={c.accent}
//           highlight={c.highlight}
//           icon={c.icon}
//           onClick={() => navigate(c.path)}
//         />
//       ))}
//     </div>
//   )
// }


function PipelineCard({
  title,
  count,
  amount,
  accentColor,
  icon,
  onClick,
  highlight = false,
}: {
  title: string
  count: string
  amount: string
  accentColor: string
  icon: React.ReactNode
  onClick?: () => void
  highlight?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
className={`group relative flex h-full min-h-0 w-full items-center justify-between overflow-hidden rounded-xl border bg-white px-5 py-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-[0.98] ${
  highlight
    ? 'border-emerald-300 shadow-emerald-100/70'
    : 'border-slate-200'
}`}
      style={{
        borderLeft: `4px solid ${accentColor}`,
        background: `linear-gradient(135deg, ${accentColor}0f 0%, #ffffff 45%)`,
      }}
    >
      <div className="min-w-0">
        <p
          className="truncate text-[11px] font-extrabold uppercase tracking-[0.12em]"
          style={{ color: accentColor }}
        >
          {title}
        </p>

        <p className="mt-1 text-[20px] sm:text-[30px] font-black leading-none tracking-tight text-slate-950 tabular-nums">
          {count}
        </p>

        <p className="mt-2 truncate text-[12px] font-bold text-slate-400 tabular-nums">
          {amount}
        </p>
      </div>

      <div
        className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl text-white shadow-sm"
        style={{ background: accentColor }}
      >
        {icon}
      </div>
    </button>
  )
}


function PipelineOverview({ data, navigate }: { data: any; navigate: any }) {
  const { label: tenderLabel }    = useModuleName('tenders')
  const { label: oppLabel }       = useModuleName('opportunities')
  const { label: woLabel }        = useModuleName('workorders')
  const { label: leadsLabel }     = useModuleName('leads')
  const { label: customersLabel } = useModuleName('customers')
  const { label: emdbgLabel }     = useModuleName('emdbg')
  const ov = data?.overview || {}

  const workOrders = num(ov.total_work_orders) || num(ov.active_work_orders)
  const pendingApprovals = num(ov.pending_approvals)
  const totalApprovals = num(ov.total_approvals) || pendingApprovals
  const leadCardCount = metric(
    ov.total_leads,
    ov.lead_count,
    ov.active_leads,
    sumMetric(ov.assigned_leads, ov.qualified_leads)
  )
  const opportunityCardCount = metric(
    ov.total_opportunities,
    ov.opportunity_count,
    sumMetric(ov.opportunity_created, ov.converted_leads)
  )
  const workOrderCount = metric(ov.total_work_orders, ov.active_work_orders, ov.active_wo)
  const emdbgCount = metric(ov.total_emdbg, ov.active_emdbg, ov.emdbg_count)

  const cards = [
    {
      key: 'leads',
      title: leadsLabel,
      count: fmtN(leadCardCount),
      amount: fmtRsL(metric(ov.lead_value)),
      accent: '#1e40af',
      path: '/leads',
      icon: <Target size={22} />,
    },
    {
      key: 'opps',
      title: oppLabel,
      count: fmtN(opportunityCardCount),
      amount: fmtRsL(metric(ov.opportunity_value)),
      accent: '#0d9488',
      path: '/opportunities',
      icon: <TrendingUp size={22} />,
    },
    {
      key: 'tenders',
      title: tenderLabel,
      count: fmtN(num(ov.total_tenders) || num(ov.active_tenders)),
      amount: fmtRsL(metric(ov.tender_value, ov.pipeline_value)),
      accent: '#7c3aed',
      path: '/tenders',
      icon: <FileText size={22} />,
    },
    {
      key: 'workorders',
      title: woLabel,
      count: fmtN(workOrderCount || workOrders),
      amount: fmtRsL(metric(ov.work_order_value, ov.total_invoiced)),
      accent: '#ea580c',
      path: '/workorders',
      icon: <LayoutDashboard size={22} />,
    },
    {
      key: 'won',
      title: 'Won',
      count: fmtN(num(ov.won_tenders)),
      amount: fmtRsL(num(ov.won_value)),
      accent: '#059669',
      path: '/tenders?status=won',
      highlight: true,
      icon: <CheckCircle size={22} />,
    },
    {
      key: 'emdbg',
      title: emdbgLabel,
      count: fmtN(emdbgCount),
      amount: fmtRsL(metric(ov.emdbg_value, ov.active_emdbg_value)),
      accent: '#2563eb',
      path: '/emdbg',
      icon: <Shield size={22} />,
    },
    {
      key: 'customers',
      title: customersLabel,
      count: fmtN(num(ov.total_customers)),
      amount: fmtRsL(metric(ov.customer_value, ov.total_invoiced)),
      accent: '#d97706',
      path: '/customers',
      icon: <Users size={22} />,
    },
    {
      key: 'approvals',
      title: 'Approvals',
      count: fmtN(pendingApprovals),
      amount: `${fmtN(totalApprovals)} total`,
      accent: '#ef4444',
      path: '/approvals',
      icon: <CheckCircle size={22} />,
    },
  ]

return (
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
    {cards.map((c) => (
      <div key={c.key} className="min-h-0 overflow-hidden rounded-xl">
        <PipelineCard
          title={c.title}
          count={c.count}
          amount={c.amount}
          accentColor={c.accent}
          icon={c.icon}
          highlight={c.highlight}
          onClick={() => navigate(c.path)}
        />
      </div>
    ))}
  </div>
)
}
/* ═══════════════════════════════════════════════════════════════
   CHART WIDGETS
   ═══════════════════════════════════════════════════════════════ */
function PipelineValueDonut({ data }: { data: any }) {
  const { label: leadsLabel }  = useModuleName('leads')
  const { label: oppLabel }    = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: emdbgLabel }  = useModuleName('emdbg')
  const ov = data?.overview || {}
  const values = {
    Leads:         metric(ov.lead_value),
    Opportunities: metric(ov.opportunity_value),
    Tenders:       metric(ov.tender_value, ov.pipeline_value),
    Won:           num(ov.won_value),
    'EMD / BG':    metric(ov.emdbg_value, ov.active_emdbg_value),
  }
  const chartData = [{ name: 'Pipeline Value', ...values }]
  const total = Object.values(values).reduce((s, v) => s + v, 0)
  const segments = [
    { key:'Leads',         display: leadsLabel,  color:'#2563eb' },
    { key:'Opportunities', display: oppLabel,     color:'#7c3aed' },
    { key:'Tenders',       display: tenderLabel,  color:'#f97316' },
    { key:'Won',           display: 'Won',        color:'#059669' },
    { key:'EMD / BG',      display: emdbgLabel,   color:'#dc2626' },
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
  const { label: leadsLabel } = useModuleName('leads')
  const mt = data?.monthly_trend || []
  return (
    <Card accent="#1e40af">
      <CardHead title={`${leadsLabel} Trend`} sub={`New ${leadsLabel.toLowerCase()} per month`} accent="#1e40af" icon={<Activity size={14}/>} />
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

function PipelineFunnel({ data }: { data: any }) {
  const { label: leadsLabel }  = useModuleName('leads')
  const { label: oppLabel }    = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const ov = data?.overview || {}
  const leadCount = metric(
    ov.total_leads,
    ov.lead_count,
    ov.active_leads,
    sumMetric(ov.assigned_leads, ov.qualified_leads)
  )
  const opportunityCount = metric(
    ov.total_opportunities,
    ov.opportunity_count,
    sumMetric(ov.opportunity_created, ov.converted_leads)
  )
  const stages = [
    { name: leadsLabel,               value: leadCount,                  color:'#1e40af' },
    { name: oppLabel,                 value: opportunityCount,            color:'#4f46e5' },
    { name: `Active ${tenderLabel}`,  value: num(ov.active_tenders),     color:'#0284c7' },
    { name: 'Won',                    value: num(ov.won_tenders),         color:'#059669' },
  ]
  const maxV = stages[0].value || 1

  return (
    <Card accent="#0284c7">
      <CardHead title="Conversion Funnel" sub="Stage-by-stage progression" accent="#0284c7" icon={<IndentIncrease size={14}/>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-1">
        {stages.map((s, i) => {
          const p = (s.value / maxV) * 100
          const conv = i > 0 ? pct(s.value, stages[i-1].value) : 100
          return (
            <div key={s.name} className="border-b border-dashed border-slate-100 py-3 last:border-b-0">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[12px] font-semibold text-slate-800">{s.name}</span>
                <div className="flex items-baseline gap-2 tabular-nums">
                  <span className="text-[16px] font-bold text-slate-900">{fmtN(s.value)}</span>
                  <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ background:`${s.color}15`, color:s.color }}>
                    {i > 0 ? `${conv}% conv` : '100%'}
                  </span>
                </div>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full transition-all duration-700"
                  style={{ width:`${Math.max(p,2)}%`, background:`linear-gradient(90deg, ${s.color}, ${s.color}88)` }} />
              </div>
            </div>
          )
        })}
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

/* ═══════════════════════════════════════════════════════════════
   UPCOMING BID DATES CALENDAR
   ═══════════════════════════════════════════════════════════════ */
function UpcomingBidsCalendar({ data, navigate }: { data: any; navigate: any }) {
  const { singular: tenderSingular } = useModuleName('tenders')
  const ov = data?.overview || {}
  const [calMonth, setCalMonth] = useState(() => new Date())
  const [tooltip, setTooltip] = useState<{ bid: any; x: number; y: number } | null>(null)
  const today = new Date()
  const tooltipWidth = 288
  const tooltipHeight = 260
  const tooltipGap = 8
  const viewportPad = 12

  const bidDates = (ov.upcoming_bid_dates || []).map((b: any) => {
    const d = new Date(b.submission_date)
    return { ...b, date:d.getDate(), month:d.getMonth(), year:d.getFullYear(), urgent:b.priority==='urgent' }
  })

  const year = calMonth.getFullYear()
  const month = calMonth.getMonth()
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const DAY_NAMES = ['Su','Mo','Tu','We','Th','Fr','Sa']

  const getBidForDay = (day: number) =>
    bidDates.find((b: any) => b.date===day && b.month===month && b.year===year)

  const urgentCount = bidDates.filter((b: any) => b.urgent).length
  const normalCount = bidDates.filter((b: any) => !b.urgent).length

  return (
    <Card accent="#2563eb">
      <CardHead
        title="Upcoming Bid Dates"
        sub={`${tenderSingular} submission calendar`}
        accent="#2563eb"
        icon={<FileText size={14}/>}
        action={
          <button onClick={() => navigate('/tenders')}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:text-blue-600">
            View all <ChevronRight size={12}/>
          </button>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_148px] items-stretch gap-3 px-4 pb-4">
  {/* CALENDAR */}
  <div className="flex h-full min-h-0 flex-col rounded-xl border border-slate-100 bg-slate-50/60 p-3">
    <div className="mb-2 flex items-center justify-between">
      <button
        onClick={() => setCalMonth(new Date(year, month - 1, 1))}
        className="rounded-lg p-1 text-slate-400 hover:bg-white hover:text-slate-700"
      >
        <ChevronLeft size={13} />
      </button>

      <span className="text-[11px] font-bold text-slate-700">
        {calMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
      </span>

      <button
        onClick={() => setCalMonth(new Date(year, month + 1, 1))}
        className="rounded-lg p-1 text-slate-400 hover:bg-white hover:text-slate-700"
      >
        <ChevronRight size={13} />
      </button>
    </div>

    <div className="grid flex-1 grid-cols-7 content-stretch gap-0.5">
      {DAY_NAMES.map((d) => (
        <div
          key={d}
          className="flex h-6 items-center justify-center text-[9px] font-bold uppercase tracking-wider text-slate-400"
        >
          {d}
        </div>
      ))}

      {Array.from({ length: firstDay }).map((_, i) => (
        <div key={`e${i}`} className="min-h-[26px]" />
      ))}

      {Array.from({ length: daysInMonth }).map((_, i) => {
        const day = i + 1
        const isToday =
          today.getDate() === day &&
          today.getMonth() === month &&
          today.getFullYear() === year
        const bid = getBidForDay(day)

        return (
          <div
            key={day}
            className={[
              'relative flex min-h-[26px] w-full cursor-default items-center justify-center rounded-md text-[11px] font-semibold transition-colors',
              isToday ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-700',
              bid && !isToday
                ? bid.urgent
                  ? 'bg-red-50 text-red-700 ring-1 ring-red-200'
                  : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                : '',
              !bid && !isToday ? 'hover:bg-white' : '',
            ].join(' ')}
            onMouseEnter={(e) => {
              if (bid) {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                const maxX = window.innerWidth - tooltipWidth - viewportPad
                const x = Math.min(Math.max(viewportPad, rect.left), Math.max(viewportPad, maxX))
                const bottomY = rect.bottom + tooltipGap
                const topY = rect.top - tooltipHeight - tooltipGap
                const hasBottomRoom = bottomY + tooltipHeight <= window.innerHeight - viewportPad
                const y = hasBottomRoom ? bottomY : Math.max(viewportPad, topY)
                setTooltip({ bid, x, y })
              }
            }}
            onMouseLeave={() => setTooltip(null)}
          >
            {day}

            {bid && (
              <span
                className={`absolute bottom-1 h-[3px] w-[3px] rounded-full ${
                  isToday ? 'bg-white' : bid.urgent ? 'bg-red-500' : 'bg-amber-500'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  </div>

 {/* SIDE CARDS */}
<div className="flex h-full min-h-0 flex-col justify-between gap-3">
  {/* URGENT */}
  <div className="flex h-[calc(50%-6px)] flex-col rounded-xl border border-red-100 bg-gradient-to-br from-red-50 to-white p-4">
    <div className="text-[9px] font-bold uppercase tracking-widest text-red-500">
      Urgent
    </div>

    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="text-[38px] font-black leading-none tabular-nums text-red-700">
        {fmtN(urgentCount)}
      </div>

      <div className="mt-3 text-[11px] font-medium text-red-500">
        Due within 3 days
      </div>
    </div>
  </div>

  {/* UPCOMING */}
  <div className="flex h-[calc(50%-6px)] flex-col rounded-xl border border-amber-100 bg-gradient-to-br from-amber-50 to-white p-4">
    <div className="text-[9px] font-bold uppercase tracking-widest text-amber-600">
      Upcoming
    </div>

    <div className="flex flex-1 flex-col items-center justify-center text-center">
      <div className="text-[38px] font-black leading-none tabular-nums text-amber-700">
        {fmtN(normalCount)}
      </div>

      <div className="mt-3 text-[11px] font-medium text-amber-600">
        Next 30 days
      </div>
    </div>
  </div>
</div>


</div>

      {tooltip && createPortal(
        <div className="pointer-events-none fixed z-[9999] max-h-[calc(100vh-24px)] w-72 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
          style={{ left:tooltip.x, top:tooltip.y }}>
          <div className="text-sm font-bold text-slate-900">{tooltip.bid.title || tooltip.bid.tender_num}</div>
          <div className="mt-0.5 text-[11px] text-slate-500">{tooltip.bid.customer}</div>
          <div className="mt-3 space-y-1.5 text-[11px]">
            {([
              [`${tenderSingular} No`,   tooltip.bid.tender_num||'—'],
              ['Submission',  tooltip.bid.submission_date ? new Date(tooltip.bid.submission_date).toLocaleDateString('en-IN') : '—'],
              ['Days Left',   tooltip.bid.days_left],
              ['Est. Value',  fmtRsL(tooltip.bid.est_value)],
              ['Portal',      tooltip.bid.portal||'—'],
              ['Status',      tooltip.bid.status||'—'],
            ] as [string,any][]).map(([k,v]) => (
              <div key={k} className="flex justify-between gap-3">
                <span className="text-slate-500">{k}</span>
                <span className={`font-semibold ${k==='Days Left'&&Number(v)<=3?'text-red-600':'text-slate-900'}`}>{v}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </Card>
  )
}

/* ═══════════════════════════════════════════════════════════════
   OTHER WIDGETS
   ═══════════════════════════════════════════════════════════════ */
function ActivityItem({ a, last }: { a: any; last: boolean }) {
  const mod = (a.module || '').toLowerCase()
  const glyph = mod.includes('tender') ? { bg:'bg-violet-50', fg:'text-violet-700', label:'TND' }
    : mod.includes('lead')   ? { bg:'bg-sky-50',    fg:'text-sky-700',    label:'LEAD' }
    : mod.includes('emd')    ? { bg:'bg-red-50',     fg:'text-red-700',    label:'EMD' }
    : mod.includes('cust')   ? { bg:'bg-emerald-50', fg:'text-emerald-700',label:'CUST' }
    : { bg:'bg-slate-50', fg:'text-slate-600', label:(a.module||'SYS').slice(0,4).toUpperCase() }

  return (
    <div className={`grid grid-cols-[32px_1fr_auto] items-start gap-2.5 py-2.5 ${last?'':'border-b border-dashed border-slate-100'}`}>
      <span className={`inline-flex h-7 w-8 items-center justify-center rounded-lg text-[9px] font-bold uppercase tracking-wider ${glyph.bg} ${glyph.fg}`}>
        {glyph.label}
      </span>
      <div className="text-[12px] leading-snug text-slate-700">
        {a.description}
        <div className="mt-0.5 text-[10px] text-slate-400 capitalize">{a.module}</div>
      </div>
      <span className="whitespace-nowrap font-mono text-[10px] text-slate-400">
        {a.created_at ? new Date(a.created_at).toLocaleString('en-IN',{dateStyle:'short',timeStyle:'short'}) : ''}
      </span>
    </div>
  )
}

function ActivityFeed({ data }: { data: any }) {
  const ra = data?.recent_activity || []
  return (
    <Card accent="#0d9488">
      <CardHead title="Activity Feed" sub="Latest system events" accent="#0d9488" icon={<Activity size={14}/>}
        action={<Badge text="LIVE" tone="dark" />} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1">
        {ra.length === 0
          ? <Empty label="No recent activity" icon={<Activity size={22}/>}/>
          : ra.map((a: any, i: number) => <ActivityItem key={i} a={a} last={i===ra.length-1}/>)}
      </div>
    </Card>
  )
}

function QuickActionsBar({ navigate }: { navigate: any }) {
  const { singular: custSingular }    = useModuleName('customers')
  const { singular: leadSingular }    = useModuleName('leads')
  const { singular: tenderSingular }  = useModuleName('tenders')
  const { label: kamLabel }           = useModuleName('kam')
  const { label: travelLabel }        = useModuleName('travel')
  const actions = [
    { label:`New ${custSingular}`,   path:'/customers', icon:<Users size={13}/>,      bg:'#1e40af' },
    { label:`New ${leadSingular}`,   path:'/leads',     icon:<Target size={13}/>,      bg:'#0d9488' },
    { label:`New ${tenderSingular}`, path:'/tenders',   icon:<FileText size={13}/>,    bg:'#7c3aed' },
    { label:`Log ${kamLabel}`,       path:'/kam',       icon:<BarChart2 size={13}/>,   bg:'#d97706' },
    { label:travelLabel,             path:'/travel',    icon:<Zap size={13}/>,         bg:'#ea580c' },
    { label:'Approvals',             path:'/approvals', icon:<CheckCircle size={13}/>, bg:'#059669' },
  ]
  return (
    <div className="flex h-full items-center gap-3 overflow-hidden rounded-2xl border border-slate-200/80 bg-white px-5 shadow-sm">
      <div className="flex items-center gap-2 border-r border-slate-200 pr-4">
        <Zap size={12} className="text-slate-400"/>
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Quick Actions</span>
      </div>
      <div className="flex flex-1 items-center gap-2 overflow-x-auto">
        {actions.map((a) => (
          <button key={a.path} onClick={() => navigate(a.path)}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg px-3.5 py-2 text-[11px] font-semibold text-white transition-all hover:-translate-y-px hover:shadow-md active:scale-[0.97]"
            style={{ background: `linear-gradient(135deg, ${a.bg}, ${a.bg}cc)`, boxShadow:`0 1px 3px ${a.bg}44` }}>
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   WIDGET RENDERER
   ═══════════════════════════════════════════════════════════════ */
function Widget({ id, data, navigate }: { id: string; data: any; navigate: any }) {
  switch (id) {
    case 'pipeline_overview':    return <PipelineOverview data={data} navigate={navigate}/>
    case 'chart_lead_trend':     return <LeadTrendChart data={data}/>
    case 'chart_pipeline_value': return <PipelineValueDonut data={data}/>
    case 'chart_lead_status':    return <LeadStatusChart data={data}/>
    case 'chart_tender_result':  return <TenderResultChart data={data}/>
    case 'chart_pipeline_funnel':return <PipelineFunnel data={data}/>
    case 'chart_lead_source':    return <LeadSourceMix/>
    case 'upcoming_bids':        return <UpcomingBidsCalendar data={data} navigate={navigate}/>
    case 'activity_feed':        return <ActivityFeed data={data}/>
    case 'quick_actions':        return <QuickActionsBar navigate={navigate}/>
    default:                     return null
  }
}

/* ═══════════════════════════════════════════════════════════════
   WIDGET PICKER
   ═══════════════════════════════════════════════════════════════ */
function WidgetPicker({
  active, onAdd, onRemove, onClose,
}: { active: string[]; onAdd:(id:string)=>void; onRemove:(id:string)=>void; onClose:()=>void }) {
  const { label: leadsLabel, singular: leadSingular, singularLower: leadLower } = useModuleName('leads')
  const { label: tenderLabel, singular: tenderSingular, singularLower: tenderLower } = useModuleName('tenders')
  const { label: oppLabel } = useModuleName('opportunities')
  const { label: woLabel } = useModuleName('workorders')
  const { label: emdbgLabel } = useModuleName('emdbg')
  const { label: customersLabel } = useModuleName('customers')

  const widgetDisplay: Record<string, { label?: string; description?: string }> = {
    pipeline_overview: { description: `${leadsLabel} → ${oppLabel} → ${tenderLabel} → ${woLabel} → Won → ${emdbgLabel} → ${customersLabel} → Approvals` },
    chart_lead_trend: { label: `${leadSingular} Trend`, description: `Monthly ${leadLower} volume trend` },
    chart_lead_status: { label: `${leadsLabel} by Status`, description: `${leadSingular} status distribution` },
    chart_tender_result: { label: `${tenderSingular} Outcomes` },
    chart_lead_source: { label: `${leadSingular} Source Mix`, description: `${leadSingular} source distribution` },
    upcoming_bids: { description: `Enhanced ${tenderLower} bid calendar` },
  }

  const [cat, setCat] = useState('Pipeline')
  const [search, setSearch] = useState('')
  const cats = [...new Set(WIDGET_REGISTRY.map((w) => w.category))]
  const filtered = WIDGET_REGISTRY.filter(
    (w) => w.category===cat && (!search || w.label.toLowerCase().includes(search.toLowerCase()) || w.description.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if(e.target===e.currentTarget) onClose() }}>
      <div className="flex max-h-[82vh] w-[640px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="border-b border-slate-100 bg-gradient-to-r from-slate-900 to-blue-950 px-6 py-5 text-white">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h2 className="text-base font-bold">Widget Library</h2>
              <p className="mt-0.5 text-xs text-slate-400">{WIDGET_REGISTRY.length} widgets available</p>
            </div>
            <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white">
              <X size={16}/>
            </button>
          </div>
          <div className="relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search widgets…"
              className="w-full rounded-lg border border-white/10 bg-white/10 py-2 pl-8 pr-3 text-sm text-white placeholder:text-slate-400 focus:border-blue-400 focus:outline-none"/>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {cats.map((c) => (
              <button key={c} onClick={() => { setCat(c); setSearch('') }}
                className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
                  cat===c ? 'bg-white text-slate-900' : 'bg-white/10 text-slate-300 hover:bg-white/20'
                }`}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto p-4">
          {filtered.map((w) => {
            const isActive = active.includes(w.id)
            return (
              <div key={w.id}
                className={`flex flex-col gap-1.5 rounded-xl border p-3.5 transition-all ${
                  isActive ? 'border-blue-200 bg-blue-50/50' : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
                }`}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold leading-tight text-slate-900">{widgetDisplay[w.id]?.label ?? w.label}</p>
                  {isActive ? (
                    <button onClick={() => onRemove(w.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-100">
                      Remove
                    </button>
                  ) : (
                    <button onClick={() => onAdd(w.id)}
                      className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700">
                      Add
                    </button>
                  )}
                </div>
                <p className="text-[11px] leading-relaxed text-slate-500">{widgetDisplay[w.id]?.description ?? w.description}</p>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   LAYOUT NORMALIZER & GRID
   ═══════════════════════════════════════════════════════════════ */
function normalizeLayout(items: WidgetLayout[]) {
  const validIds = new Set(WIDGET_REGISTRY.map((w) => w.id))

  return items
    .filter((x) => validIds.has(x.id))
    .map((x, i) => {
      const m = WIDGET_REGISTRY.find((w) => w.id === x.id)!

      const fixedH =
        x.id === 'pipeline_overview' ? 3 :
        x.id === 'quick_actions' ? 1 :
        x.id.startsWith('chart_') || x.id === 'upcoming_bids' || x.id === 'activity_feed' ? 5 :
        Number(x.h) || m.defaultH

      return {
        id: x.id,
        w: Math.min(m.maxW, Math.max(m.minW, Number(x.w) || m.defaultW)),
        h: fixedH,
        order: Number.isFinite(x.order) ? x.order : i,
      }
    })
    .sort((a, b) => a.order - b.order)
    .map((x, i) => ({ ...x, order: i }))
}

function ResizeHandle({ direction, onResize }: { direction: 'w' | 'h'; onResize: (delta: number) => void }) {
  const startRef = useRef(0)

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    startRef.current = direction === 'w' ? e.clientX : e.clientY

    const onMove = (ev: MouseEvent) => {
      const delta = direction === 'w'
        ? Math.round((ev.clientX - startRef.current) / 180)
        : Math.round((ev.clientY - startRef.current) / 70)

      if (delta !== 0) {
        onResize(delta)
        startRef.current = direction === 'w' ? ev.clientX : ev.clientY
      }
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={onMouseDown}
      className={`absolute z-30 opacity-0 transition-opacity group-hover:opacity-100 ${
        direction === 'w'
          ? 'right-0 top-1/2 -mr-1 h-10 w-2 -translate-y-1/2 cursor-ew-resize rounded-full bg-blue-400/70'
          : 'bottom-0 left-1/2 -mb-1 h-2 w-10 -translate-x-1/2 cursor-ns-resize rounded-full bg-blue-400/70'
      }`}
    />
  )
}

function DashboardGrid({ layout, data, navigate, editMode, onReorder, onRemove, onResize }:{
  layout:WidgetLayout[]; data:any; navigate:any; editMode:boolean
  onReorder:(l:WidgetLayout[])=>void
  onRemove:(id:string)=>void
  onResize:(id:string,dw:number,dh:number)=>void
}) {
  const dragRef = useRef<string|null>(null)
  const overRef = useRef<string|null>(null)

  const onDragStart = (id:string) => { dragRef.current = id }
  const onDragOver  = (e:React.DragEvent, id:string) => { e.preventDefault(); overRef.current = id }
  const onDrop = () => {
    const from = dragRef.current, to = overRef.current
    if (!from || !to || from===to) return
    const arr = [...layout].sort((a,b)=>a.order-b.order)
    const fi = arr.findIndex((x)=>x.id===from)
    const ti = arr.findIndex((x)=>x.id===to)
    if (fi<0||ti<0) return
    const [item] = arr.splice(fi,1)
    arr.splice(ti,0,item)
    arr.forEach((x,i) => { x.order=i })
    onReorder(arr)
    dragRef.current = null; overRef.current = null
  }

  const COL: Record<number,string> = { 1:'col-span-1', 2:'col-span-2', 3:'col-span-2 sm:col-span-3', 4:'col-span-2 sm:col-span-4' }
  const ROW: Record<number,string> = { 1:'sm:row-span-1', 2:'sm:row-span-2', 3:'sm:row-span-3', 4:'sm:row-span-4', 5:'sm:row-span-5', 6:'sm:row-span-6' }

  return (
<div className="grid grid-flow-row-dense auto-rows-auto sm:auto-rows-[70px] grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-3.5">      {[...layout].sort((a,b)=>a.order-b.order).map((item) => {
        const cs = COL[Math.min(4,Math.max(1,item.w))] || 'col-span-2'
        const rs = ROW[Math.min(6,Math.max(1,item.h))] || 'sm:row-span-3'
        return (
          <div key={item.id} className={`group relative min-h-[180px] sm:min-h-0 ${cs} ${rs}`}
            draggable={editMode} onDragStart={()=>onDragStart(item.id)}
            onDragOver={(e)=>onDragOver(e,item.id)} onDrop={onDrop}>
            {editMode && (
              <>
                <div className="absolute left-2 top-2 z-30 cursor-grab rounded-lg border border-slate-200 bg-white/95 p-1 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 active:cursor-grabbing">
                  <GripVertical size={12} className="text-slate-400"/>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  className="absolute right-2 top-2 z-30 rounded-lg border border-slate-200 bg-white/95 p-1 text-slate-400 opacity-0 shadow-sm backdrop-blur transition-all hover:border-red-200 hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                  aria-label="Remove widget"
                >
                  <X size={12}/>
                </button>
                <ResizeHandle direction="w" onResize={(delta) => onResize(item.id, delta, 0)} />
                <ResizeHandle direction="h" onResize={(delta) => onResize(item.id, 0, delta)} />
              </>
            )}
            <Widget id={item.id} data={data} navigate={navigate}/>
          </div>
        )
      })}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   HERO HEADER STATS
   ═══════════════════════════════════════════════════════════════ */
function HeroMetricCard({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent: string
}) {
  return (
    <div className="min-w-0 px-3 sm:px-8 first:pl-0 last:pr-0" aria-label={label}>
      <div className="text-[9px] font-black uppercase tracking-[0.08em]" style={{ color: accent }}>{label}</div>
      <div className="mt-2 text-[22px] sm:text-[30px] font-black leading-none tracking-tight text-white tabular-nums">{value}</div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   PARSE LAYOUT PREFERENCE
   ═══════════════════════════════════════════════════════════════ */
function parseLayoutPref(raw: any): WidgetLayout[] | null {
  if (!raw) return null
  try {
    const parsed = typeof raw==='string' ? JSON.parse(raw) : raw
    if (Array.isArray(parsed) && parsed.length>0 && 'id' in parsed[0])
      return normalizeLayout(parsed as WidgetLayout[])
  } catch {}
  return null
}

interface DashboardOverviewCache {
  data?: any
  layout?: WidgetLayout[]
}

const DASHBOARD_OVERVIEW_CACHE_VERSION = 'v2'

function getDashboardOverviewCacheKey(tenantSlug?: string | null, userId?: number | string | null): string | null {
  const slug = String(tenantSlug || localStorage.getItem('tenant_slug') || '').trim()
  const id = userId == null ? '' : String(userId).trim()
  return slug && id ? `crm_dashboard_overview:${DASHBOARD_OVERVIEW_CACHE_VERSION}:${slug}:${id}` : null
}

function readDashboardOverviewCache(cacheKey: string | null): DashboardOverviewCache | null {
  if (!cacheKey) return null
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey) || 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as DashboardOverviewCache
  } catch {
    return null
  }
}

function writeDashboardOverviewCache(cacheKey: string | null, patch: DashboardOverviewCache): void {
  if (!cacheKey) return
  try {
    const current = readDashboardOverviewCache(cacheKey) || {}
    localStorage.setItem(cacheKey, JSON.stringify({ ...current, ...patch }))
  } catch {
    // Dashboard should continue normally if browser storage is unavailable.
  }
}

/* ═══════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════ */
export default function OverviewTab() {
  const { label: tenderLabelHero } = useModuleName('tenders')
  const { user, tenant_slug } = useAuthStore()
  const cacheKey = getDashboardOverviewCacheKey(tenant_slug, user?.id)
  const initialCacheRef = useRef<DashboardOverviewCache | null>(readDashboardOverviewCache(cacheKey))
  const [data, setData] = useState<any>(() => initialCacheRef.current?.data ?? null)
  const [loading, setLoading] = useState(() => !initialCacheRef.current?.data)
  const [layout, setLayout] = useState<WidgetLayout[]>(() => {
    const cachedLayout = parseLayoutPref(initialCacheRef.current?.layout)
    return cachedLayout?.length ? cachedLayout : DEFAULT_LAYOUT
  })
  const [saving, setSaving] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const navigate = useNavigate()

  const saveLayout = async (l: WidgetLayout[]) => {
    writeDashboardOverviewCache(cacheKey, { layout: l })
    setSaving(true)
    try { await api.put('/dashboard/preference', { widgets: JSON.stringify(l) }) }
    catch (err) { console.error('Failed to save layout:', err) }
    finally { setSaving(false) }
  }

  const loadData = useCallback(async (showSkeleton = false) => {
    const hasRenderableData = Boolean(readDashboardOverviewCache(cacheKey)?.data)
    if (showSkeleton || !hasRenderableData) setLoading(true)
    try {
      const dashRes = await api.get('/dashboard')
      setData(dashRes.data)
      writeDashboardOverviewCache(cacheKey, { data: dashRes.data })
    } catch (err) { console.error('Dashboard load failed:', err) }
    finally { setLoading(false) }
  }, [cacheKey])

  useEffect(() => {
    const cached = readDashboardOverviewCache(cacheKey)
    if (cached?.data) {
      setData(cached.data)
      setLoading(false)
    } else {
      setData(null)
      setLoading(true)
    }

    const cachedLayout = parseLayoutPref(cached?.layout)
    setLayout(cachedLayout?.length ? cachedLayout : DEFAULT_LAYOUT)

    loadData(false)

    api.get('/dashboard/preference')
      .then((prefRes) => {
        const saved = parseLayoutPref(prefRes.data?.widgets ?? prefRes.data?.layout)
        if (saved?.length) {
          setLayout(saved)
          writeDashboardOverviewCache(cacheKey, { layout: saved })
        }
      })
      .catch(() => {})
  }, [cacheKey, loadData])

  const handleReorder = (l: WidgetLayout[]) => { const n=normalizeLayout(l); setLayout(n); saveLayout(n) }
  const handleAdd = (id: string) => {
    if (layout.find((x)=>x.id===id)) return
    const meta = WIDGET_REGISTRY.find((w)=>w.id===id)
    if (!meta) return
    const n = normalizeLayout([...layout, { id, w:meta.defaultW, h:meta.defaultH, order:layout.length }])
    setLayout(n); saveLayout(n)
  }
  const handleRemove = (id: string) => { const n=normalizeLayout(layout.filter((x)=>x.id!==id)); setLayout(n); saveLayout(n) }
  const handleResize = (id: string, dw: number, dh: number) => {
    const n = normalizeLayout(layout.map((x) => {
      if (x.id !== id) return x
      const meta = WIDGET_REGISTRY.find((w) => w.id === id)
      if (!meta) return x
      return {
        ...x,
        w: Math.min(meta.maxW, Math.max(meta.minW, x.w + dw)),
        h: Math.min(6, Math.max(1, x.h + dh)),
      }
    }))
    setLayout(n)
    saveLayout(n)
  }
  const handleReset = () => { const n = normalizeLayout(DEFAULT_LAYOUT); setLayout(n); saveLayout(n) }

  /* ── Loading skeleton ── */
  if (loading) {
    return (
      <div className="space-y-3 p-3 sm:p-6">
        <div className="h-[76px] w-full animate-pulse rounded-2xl bg-slate-800/10 shadow-sm" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[...Array(8)].map((_,i) => <div key={i} className="h-[78px] animate-pulse rounded-xl bg-white shadow-sm"/>)}
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          {[...Array(4)].map((_,i) => <div key={i} className="h-[390px] animate-pulse rounded-2xl bg-white shadow-sm"/>)}
        </div>
        <div className="h-[78px] w-full animate-pulse rounded-2xl bg-white shadow-sm"/>
      </div>
    )
  }

  /* ── Derived hero stats ── */
  const ov = data?.overview || {}
  const pipelineVal = metric(ov.tender_value, ov.pipeline_value)
  const wonVal      = num(ov.won_value)
  const wonTenders  = num(ov.won_tenders)
  const winRate     = num(ov.total_tenders) ? Math.round((wonTenders / num(ov.total_tenders)) * 100) : 0

  const fullName  = user?.full_name ?? user?.username ?? ''
  const firstName = fullName.split(' ')[0] || 'there'
  const now  = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="min-h-screen space-y-3.5 bg-slate-100/70 p-3 sm:p-5">

      {/* ── PREMIUM HERO HEADER ── */}
      <div
        className="relative overflow-hidden rounded-[16px] px-6 py-4 shadow-[0_16px_34px_rgba(15,23,42,0.18)]"
        style={{
          background: 'linear-gradient(120deg, var(--color-primary) 0%, var(--color-secondary) 58%, var(--color-accent) 100%)',
          boxShadow: '0 22px 48px color-mix(in srgb, var(--color-primary) 24%, transparent)',
        }}
      >

        <div className="relative flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          {/* Left: greeting */}
          <div className="min-w-[280px] flex-shrink-0">
            <h1 className="text-[21px] font-black tracking-tight text-white">
              {greeting}, <span style={{ color: 'color-mix(in srgb, var(--color-accent) 72%, white)' }}>{firstName}</span>.
            </h1>
            <div className="mt-2 flex items-center gap-2 text-[12px] font-medium text-white/70">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--color-success)' }} />
              <span>{now.toLocaleDateString('en-IN',{ weekday:'long', day:'numeric', month:'long', year:'numeric' })}</span>
              {saving && <span className="font-mono text-[11px] text-white/50">saving...</span>}
            </div>
          </div>

          {/* Center: key metrics */}
          <div className="flex w-auto min-w-0 flex-shrink-0 items-center divide-x divide-white/20">
            <HeroMetricCard
              label={`${tenderLabelHero} Value`}
              value={fmtRsL(pipelineVal)}
              accent="color-mix(in srgb, var(--color-accent) 82%, white)"
            />
            <HeroMetricCard
              label="Won Value"
              value={fmtRsL(wonVal)}
              accent="color-mix(in srgb, var(--color-success) 82%, white)"
            />
            <HeroMetricCard
              label="Win Rate"
              value={`${winRate}%`}
              accent="color-mix(in srgb, var(--color-accent) 64%, white)"
            />
          </div>

          {/* Right: controls */}
          <div className="flex flex-shrink-0 items-center gap-2 border-t border-white/15 pt-3 xl:border-l xl:border-t-0 xl:py-2 xl:pl-5">
            {editMode && (
              <>
                <button onClick={() => setShowPicker(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 text-[11px] font-bold text-white backdrop-blur transition-all hover:bg-white/18">
                  <Plus size={13}/> Add Widget
                </button>
                <button onClick={handleReset}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 text-[11px] font-bold text-white backdrop-blur transition-all hover:bg-white/18">
                  <RotateCcw size={13}/> Reset
                </button>
              </>
            )}
            <button onClick={() => setEditMode((value) => !value)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-bold backdrop-blur transition-all ${
                editMode
                  ? 'border-white/30 bg-white text-slate-900 hover:bg-white/90'
                  : 'border-white/20 bg-white/10 text-white hover:bg-white/18'
              }`}>
              {editMode ? <><CheckCircle size={13}/> Done</> : <><Settings2 size={13}/> Customize</>}
            </button>
            <button onClick={() => loadData(false)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 text-[11px] font-bold text-white backdrop-blur transition-all hover:bg-white/18">
              <RefreshCw size={13}/> Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── EDIT MODE INFO ── */}
      {editMode && (
        <div className="flex items-center gap-3 rounded-2xl border border-blue-200/70 bg-blue-50 px-5 py-3 text-blue-700 shadow-sm">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-blue-100">
            <LayoutDashboard size={14}/>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold">Dashboard Edit Mode</p>
            <p className="mt-0.5 text-[11px] text-blue-600">Drag widgets to reorder • use edge handles to resize • click × to remove • layout saves automatically</p>
          </div>
          <button onClick={() => setEditMode(false)} className="rounded-lg px-2 py-1 text-[11px] font-bold hover:bg-blue-100">
            Close
          </button>
        </div>
      )}

      {/* ── WIDGET GRID ── */}
      <DashboardGrid
        layout={layout}
        data={data}
        navigate={navigate}
        editMode={editMode}
        onReorder={handleReorder}
        onRemove={handleRemove}
        onResize={handleResize}
      />

      {/* ── WIDGET PICKER ── */}
      {showPicker && (
        <WidgetPicker
          active={layout.map((x)=>x.id)}
          onAdd={handleAdd}
          onRemove={handleRemove}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}
