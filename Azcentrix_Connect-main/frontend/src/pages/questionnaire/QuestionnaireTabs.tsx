import { NavLink } from 'react-router-dom'
import { ClipboardList } from 'lucide-react'
import { usePermissions } from '@/hooks'

const TABS = [
  { to: '/questionnaire', label: 'Customer Questionnaires', end: true, permission: 'questionnaire.view', icon: <ClipboardList size={13} /> },
]

export function useQuestionnaireTabs() {
  const { can } = usePermissions()
  const visibleTabs = TABS.filter((tab) => can(tab.permission))

  if (visibleTabs.length <= 1) return null

  return (
    <div className="flex w-fit items-center gap-1 rounded-2xl bg-slate-100 p-1.5">
      {visibleTabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-xs font-semibold transition-all ${
              isActive
                ? 'bg-white text-slate-900 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`
          }
        >
          {tab.icon}
          {tab.label}
        </NavLink>
      ))}
    </div>
  )
}

export default function QuestionnaireTabs() {
  return useQuestionnaireTabs()
}
