import { useState } from 'react'
import { BarChart3, Headphones, RefreshCw, Settings, ShieldCheck, Sparkles, Wrench } from 'lucide-react'
import { authApi } from '@/services/api'
import { useAuthStore } from '@/store'
import { clearAuthStorage } from '@/utils/auth'

const improvements = [
  { label: 'Improved', detail: 'Performance', icon: Settings, tone: 'bg-blue-100 text-blue-600' },
  { label: 'Enhanced', detail: 'Security', icon: ShieldCheck, tone: 'bg-emerald-100 text-emerald-600' },
  { label: 'New', detail: 'Features', icon: BarChart3, tone: 'bg-violet-100 text-violet-600' },
  { label: 'Better', detail: 'Experience', icon: Sparkles, tone: 'bg-fuchsia-100 text-fuchsia-600' },
]

const supportMailto = `mailto:software@aedindia.com?subject=${encodeURIComponent('AzcentrixConnect - Application Maintenance')}&body=${encodeURIComponent([
  'Hello Support Team,',
  '',
  'I am unable to access AzcentrixConnect because',
  'the application is currently under maintenance.',
  '',
  'Please let me know when the application will',
  'be available again.',
  '',
  'Regards,',
  '[User Name]',
].join('\\n'))}`

export default function MaintenancePage() {
  const [refreshing, setRefreshing] = useState(false)

  const refreshPage = async () => {
    setRefreshing(true)
    try {
      const { data } = await authApi.maintenanceStatus('')
      if (!data.maintenance_mode) {
        // A user who reached this page may still have a valid tenant session.
        // Clear it before opening Login so React cannot redirect to Dashboard.
        useAuthStore.getState().logout()
        clearAuthStorage()
        window.sessionStorage.clear()
        window.location.replace('/login')
        return
      }
      window.location.reload()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#f5f6fe] px-8 py-8 text-slate-900 sm:px-12 lg:px-20">
      <style>{`
        @keyframes maintenance-wave-flow {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
      `}</style>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-[46%] w-full overflow-hidden">
          <svg
            className="h-full w-[200%]"
            style={{ animation: 'maintenance-wave-flow 10s linear infinite' }}
            viewBox="0 0 2880 460"
            preserveAspectRatio="none"
          >
            <path
              d="M0,180 C240,240 420,90 720,130 C1020,170 1260,250 1440,190 C1680,240 1860,90 2160,130 C2460,170 2700,250 2880,190 L2880,460 L0,460 Z"
              fill="#e5e7fa"
            />
          </svg>
        </div>
      </div>

      <div className="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-none flex-col">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-100 bg-white shadow-sm">
              <img src="/azcentrix-logo.png" alt="Azcentrix Connect logo" className="h-6 w-6 object-contain" />
            </div>
            <span className="text-base font-extrabold tracking-tight">
              <span className="text-slate-900">Azcentrix</span>
              <span className="bg-gradient-to-r from-fuchsia-600 via-purple-600 to-blue-600 bg-clip-text text-transparent">Connect</span>
            </span>
          </div>
          <a href={supportMailto} className="text-sm font-medium text-indigo-600 hover:text-indigo-800">Need help?</a>
        </header>

        <section className="mx-auto flex flex-1 flex-col items-center justify-center py-14 text-center">
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-white px-4 py-2 text-sm font-semibold text-indigo-600 shadow-sm">
            <Wrench size={15} /> Scheduled maintenance
          </div>
          <h1 className="max-w-3xl text-5xl font-extrabold leading-[1.05] tracking-tight text-slate-900 sm:text-7xl">
            We&apos;ll be<br /><span className="bg-gradient-to-r from-fuchsia-600 via-purple-600 to-blue-600 bg-clip-text text-transparent">back soon!</span>
          </h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">
            Our application is currently under maintenance.<br />We&apos;re working to serve you better.
          </p>

          <div className="mt-11 grid grid-cols-2 gap-x-10 gap-y-7 sm:grid-cols-4 sm:gap-x-16">
            {improvements.map(({ label, detail, icon: Icon, tone }) => (
              <div key={detail} className="flex w-24 flex-col items-center">
                <div className={`flex h-16 w-16 items-center justify-center rounded-full ${tone}`}><Icon size={27} /></div>
                <p className="mt-4 text-sm font-semibold leading-5 text-slate-700">{label}<br />{detail}</p>
              </div>
            ))}
          </div>

          <div className="mt-11 flex flex-col gap-3 sm:flex-row">
            <button type="button" onClick={() => void refreshPage()} disabled={refreshing} className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-violet-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition hover:brightness-110 disabled:opacity-70">
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /> Refresh page
            </button>
            <a href={supportMailto} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-6 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50">
              <Headphones size={16} /> Contact support
            </a>
          </div>
        </section>

        <footer className="flex flex-col justify-between gap-2 text-xs text-slate-500 sm:flex-row">
          <span>© {new Date().getFullYear()} Azcentrix Connect. All rights reserved.</span>
          <a href={supportMailto} className="hover:text-indigo-600">software@aedindia.com</a>
        </footer>
      </div>
    </main>
  )
}
