import { CreditCard, Plane } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

type TravelModuleTab = 'requests' | 'claims'

export default function TravelModuleTabs({
  active,
  requestCount,
  claimCount,
}: {
  active: TravelModuleTab
  requestCount?: number
  claimCount?: number
  travelLabel?: string
}) {
  const navigate = useNavigate()
  const tabs = [
    {
      id: 'requests' as const,
      label: 'Travel Requests',
      count: requestCount,
      icon: <Plane size={13} />,
      path: '/travel',
    },
    {
      id: 'claims' as const,
      label: 'Travel Claims',
      count: claimCount,
      icon: <CreditCard size={13} />,
      path: '/travel/claims',
    },
  ]

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1 bg-slate-100 rounded-2xl p-1.5 w-fit">
        {tabs.map(tab => {
          const selected = active === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => { if (!selected) navigate(tab.path) }}
              className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap ${
                selected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {tab.icon}
              {tab.label}
              {typeof tab.count === 'number' && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold leading-none">
                  {tab.count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
