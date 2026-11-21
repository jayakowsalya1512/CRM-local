import { Outlet } from 'react-router-dom'

export default function QuestionnairePage() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  )
}
