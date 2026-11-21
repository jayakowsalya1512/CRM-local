import { useState } from 'react'
import { Plane, Receipt } from 'lucide-react'
import TravelPage from './TravelPage'
import TADAPage from '@/pages/tada/TADAPage'
import { useModuleName } from '@/context/ModuleLabelsContext'

type Tab = 'travel' | 'tada'

export default function TravelTADAPage() {
  const { label: travelLabel } = useModuleName('travel')
  const [activeTab, setActiveTab] = useState<Tab>('travel')

  return (
    <div className="flex flex-col h-full">
      {/* Tab Header */}

    


      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'travel' ? <TravelPage /> : <TADAPage />}
      </div>
    </div>
  )
}
