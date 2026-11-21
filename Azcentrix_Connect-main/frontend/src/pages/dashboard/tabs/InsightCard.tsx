/**
 * InsightCard.tsx — small derived-text insight cards for analytics tabs.
 * Tone/pill styling ported from AiInsights/InsightsPage.tsx's executive-summary pattern.
 */
import { TrendingUp, TrendingDown, AlertTriangle, Info, Sparkles } from 'lucide-react'
import type { Tone } from './_shared'

export interface InsightItem {
  title: string
  detail: string
  value?: string | number
  tone: Tone
  onClick?: () => void
}

const ACCENT: Record<Tone, string> = {
  pos: 'border-l-emerald-500 bg-emerald-50/40',
  neg: 'border-l-red-500 bg-red-50/40',
  warn: 'border-l-amber-500 bg-amber-50/40',
  info: 'border-l-sky-500 bg-sky-50/40',
  neutral: 'border-l-slate-300 bg-slate-50/40',
  dark: 'border-l-slate-900 bg-slate-50/40',
  purple: 'border-l-purple-500 bg-purple-50/40',
}
const ICON: Record<Tone, React.ReactNode> = {
  pos: <TrendingUp size={13} className="text-emerald-600" />,
  neg: <TrendingDown size={13} className="text-red-600" />,
  warn: <AlertTriangle size={13} className="text-amber-600" />,
  info: <Info size={13} className="text-sky-600" />,
  neutral: <Sparkles size={13} className="text-slate-500" />,
  dark: <Sparkles size={13} className="text-slate-900" />,
  purple: <Sparkles size={13} className="text-purple-600" />,
}
const VALUE_COLOR: Record<Tone, string> = {
  pos: 'text-emerald-700', neg: 'text-red-700', warn: 'text-amber-700',
  info: 'text-sky-700', neutral: 'text-slate-700', dark: 'text-slate-900', purple: 'text-purple-700',
}

export function InsightCard({ item, onClick }: { item: InsightItem; onClick?: () => void }) {
  const handleClick = onClick || item.onClick
  return (
    <div
      onClick={handleClick}
      className={[
        'flex flex-col gap-1.5 rounded-xl border border-slate-200 border-l-[3px] p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-all duration-150',
        ACCENT[item.tone],
        handleClick ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(15,23,42,0.07)]' : '',
      ].join(' ')}
    >
      <div className="flex items-center gap-1.5">
        {ICON[item.tone]}
        <span className="text-[11.5px] font-bold text-slate-800">{item.title}</span>
      </div>
      <div className="text-[11.5px] leading-snug text-slate-600">{item.detail}</div>
      {item.value != null && (
        <div className={`mt-0.5 text-[15px] font-bold tabular-nums ${VALUE_COLOR[item.tone]}`}>{item.value}</div>
      )}
    </div>
  )
}

export function InsightGrid({ items, cols = 5 }: { items: InsightItem[]; cols?: number }) {
  if (!items?.length) return null
  const gridCls = cols === 5 ? 'md:grid-cols-3 xl:grid-cols-5' : cols === 4 ? 'md:grid-cols-2 xl:grid-cols-4' : `md:grid-cols-${cols}`
  return (
    <div className={`grid grid-cols-1 gap-3 ${gridCls}`}>
      {items.map((it, i) => <InsightCard key={i} item={it} onClick={it.onClick} />)}
    </div>
  )
}
