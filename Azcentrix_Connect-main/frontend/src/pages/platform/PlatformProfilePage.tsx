import { useEffect, useState } from 'react'
import { Activity, Clock, KeyRound, LogOut, Mail, ShieldCheck, ShieldOff, UserRound } from 'lucide-react'
import { platformApi, type PlatformAuditEntry } from '@/services/platformApi'
import { useToast } from '@/components/ui/ToastContext'

type Profile = { full_name: string; username: string; email: string }

export default function PlatformProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [activity, setActivity] = useState<PlatformAuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activityError, setActivityError] = useState(false)
  const [logoutCount, setLogoutCount] = useState<number | null>(null)
  const [lastLogin, setLastLogin] = useState<string | null>(null)

  const [sendingReset, setSendingReset] = useState(false)
  const { success, error: showError } = useToast()

  const sendReset = async () => {
    setSendingReset(true)
    try {
      await platformApi.requestPasswordReset()
      success('Reset link sent', "Check your saved email address for the password reset link.")
    } catch (err: any) {
      showError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Unable to send the reset email. Please try again.')
    } finally { setSendingReset(false) }
  }

  useEffect(() => {
    let active = true
    platformApi.me().then(async ({ data }) => {
      if (!active) return
      setProfile(data)
      try {
        const response = await platformApi.accountActivity()
        if (active) { setActivity(response.data.activity); setLogoutCount(response.data.self_logout_count); setLastLogin(response.data.last_login) }
      } catch { if (active) setActivityError(true) }
    }).catch(() => { if (active) setError('Unable to load your profile. Please try again.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const initials = (profile?.username || 'S').slice(0, 1).toUpperCase()
  return (
    <div className="mx-auto flex min-h-0 max-w-[1500px] flex-col lg:h-full">
      <p className="text-sm text-slate-400">Account <span className="mx-2">/</span> <span className="text-slate-700">Profile</span></p>
      <h2 className="mt-2 text-2xl font-bold text-slate-900">My Account</h2>
      <p className="mt-1 text-sm text-slate-500">View your Super Admin profile and account activity.</p>
      {loading ? <p className="mt-8 text-sm text-slate-500">Loading profile...</p> : error ? <p role="alert" className="mt-8 rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p> : profile && (
        <div className="mt-5 flex min-h-0 flex-1 flex-col gap-3">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Logout Alerts', value: 'Unavailable', icon: LogOut, tone: 'bg-blue-50 text-blue-600' },
              { label: 'Admin Forced', value: 'Unavailable', icon: ShieldOff, tone: 'bg-red-50 text-red-500' },
              { label: 'Self Logout', value: logoutCount === null ? 'Unavailable' : String(logoutCount), icon: ShieldCheck, tone: 'bg-emerald-50 text-emerald-600' },
              { label: 'Latest Alert', value: 'Unavailable', icon: Clock, tone: 'bg-amber-50 text-amber-600' },
            ].map(({ label, value, icon: Icon, tone }) => (
              <div key={label} className="flex min-h-[78px] items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-sm font-bold text-slate-700">{value}</p></div>
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon size={19} /></span>
              </div>
            ))}
          </div>

          <div className="grid min-h-0 gap-4 lg:h-[410px] lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-base font-bold text-white">{initials}</div>
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-lg font-bold text-slate-900">Super Admin</h3><span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">Active</span></div><p className="mt-1 truncate text-sm text-slate-500">@{profile.username}</p><span className="mt-2 inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700"><ShieldCheck size={13} /> Super Admin</span></div>
            </div>
            <div className="flex flex-1 flex-col gap-2 p-3">
              <div className="flex flex-1 items-center gap-3 rounded-xl bg-slate-50 px-3 py-2"><Mail size={18} className="mt-0.5 shrink-0 text-blue-600" /><div className="min-w-0"><p className="text-xs font-semibold uppercase text-slate-400">Email</p><p className="mt-1 break-all text-sm text-slate-800">{profile.email}</p></div></div>
              <div className="flex flex-1 items-center gap-3 rounded-xl bg-slate-50 px-3 py-2"><UserRound size={18} className="mt-0.5 shrink-0 text-blue-600" /><div><p className="text-xs font-semibold uppercase text-slate-400">Username</p><p className="mt-1 text-sm text-slate-800">@{profile.username}</p></div></div>
              <div className="flex flex-1 items-center gap-3 rounded-xl bg-slate-50 px-3 py-2"><Clock size={18} className="mt-0.5 shrink-0 text-amber-500" /><div><p className="text-xs font-semibold uppercase text-slate-400">Last Login</p><p className="mt-1 text-sm text-slate-800">{lastLogin ? new Date(lastLogin).toLocaleString() : 'Not recorded yet'}</p></div></div>
              <button type="button" onClick={sendReset} disabled={sendingReset} className="flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 transition-colors hover:border-blue-200 hover:bg-blue-50"><KeyRound size={16} /> {sendingReset ? 'Sending...' : 'Reset Password'}</button>
            </div>
          </section>
          <section className="flex min-h-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2"><Activity size={20} className="text-blue-600" /><h3 className="text-lg font-bold text-slate-900">Recent Account Activity</h3></div>
            <p className="mt-1 text-sm text-slate-500">Your recent platform administration actions.</p>
            <div className="mt-4 min-h-0 max-h-[420px] flex-1 space-y-2 overflow-y-auto pr-1">
              {activityError ? <p className="rounded-xl bg-red-50 p-5 text-sm text-red-700">Unable to load activity.</p> : activity.length === 0 ? <div className="rounded-xl border border-dashed border-slate-200 px-5 py-10 text-center text-sm text-slate-500">No recorded account activity yet.</div> : activity.map(item => (
                <div key={item.id} className="rounded-xl border border-slate-100 p-3"><p className="font-semibold capitalize text-slate-800">{item.action.replace(/[_-]/g, ' ')}</p><p className="mt-1 text-sm text-slate-500">{item.description || item.entity_name || item.entity_type}</p><p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400"><Clock size={13} /> {new Date(item.created_at).toLocaleString()}</p></div>
              ))}
            </div>
          </section>
          </div>
        </div>
      )}

    </div>
  )
}
