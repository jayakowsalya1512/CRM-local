/**
 * ModuleTab.tsx — thin dispatcher
 * Lazily loads each module tab so they are code-split per route.
 * Each tab owns its own data fetching and filter state.
 */

import { lazy, Suspense } from 'react'

const CustomersTab = lazy(() => import('./CustomersTab'))
const LeadsTab     = lazy(() => import('./LeadsTab'))
const TendersTab   = lazy(() => import('./TendersTab'))
const TravelTab    = lazy(() => import('./TravelTab'))
const EMDBGTab     = lazy(() => import('./EMDBGTab'))
const KAM360Tab    = lazy(() => import('./KAM360Tab'))
const LoginTrackerTab = lazy(() => import('./LoginTrackerTab')) 

function TabSkeleton() {
  return (
    <div className="space-y-4 p-6">
      <div className="h-16 animate-pulse rounded-2xl bg-white shadow-sm" />
      <div className="grid grid-cols-6 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-2xl bg-white shadow-sm" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-72 animate-pulse rounded-2xl bg-white shadow-sm" style={{ animationDelay: `${(i + 6) * 60}ms` }} />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-2xl bg-white shadow-sm" />
    </div>
  )
}

export default function ModuleTab({ module }: { module: string }) {
  return (
    <Suspense fallback={<TabSkeleton />}>
  {module === 'customers' && <CustomersTab />}
  {module === 'leads'     && <LeadsTab />}
  {module === 'tenders'   && <TendersTab />}
  {module === 'travel'    && <TravelTab />}
  {module === 'emdbg'     && <EMDBGTab />}
  {module === 'kam360'    && <KAM360Tab />}
  {module === 'login_tracker' && <LoginTrackerTab />}            {/* ← ADD HERE */}
</Suspense>
  )
}
