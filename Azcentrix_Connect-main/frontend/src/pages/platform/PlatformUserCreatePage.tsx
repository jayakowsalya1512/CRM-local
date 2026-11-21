import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronRight, Eye, EyeOff, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { platformApi } from '@/services/platformApi'
import { useToast } from '@/components/ui/ToastContext'

export default function PlatformUserCreatePage() {
  const navigate = useNavigate()
  const { id } = useParams()
  const isEdit = Boolean(id)
  const [loading, setLoading] = useState(Boolean(id))
  const [loadFailed, setLoadFailed] = useState(false)
  const { success } = useToast()
  const [form, setForm] = useState({ username: '', full_name: '', email: '', password: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!id) return
    let active = true
    platformApi.listSuperAdmins().then(({ data }) => {
      if (!active) return
      const user = data.find(item => String(item.id) === id)
      if (!user) { setError('Platform user not found.'); setLoadFailed(true); return }
      setForm({ username: user.username, full_name: user.full_name, email: user.email, password: '' })
    }).catch(() => { if (active) { setError('Unable to load this platform user.'); setLoadFailed(true) } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [id])
  const set = (key: keyof typeof form, value: string) => setForm(current => ({ ...current, [key]: value }))
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if ((!isEdit || form.password) && (form.password.length < 8 || !/[A-Z]/.test(form.password) || !/[a-z]/.test(form.password) || !/[0-9]/.test(form.password) || !/[^A-Za-z0-9\s]/.test(form.password))) { setError('Please enter a password that meets the security requirements.'); return }
    setSaving(true)
    try {
      if (isEdit) {
        await platformApi.updateSuperAdmin(Number(id), { full_name: form.full_name.trim(), email: form.email.trim(), ...(form.password ? { password: form.password } : {}) })
      } else {
        await platformApi.createSuperAdmin({ username: form.username.trim(), full_name: form.full_name.trim(), email: form.email.trim(), password: form.password })
      }
      success(isEdit ? 'Platform user updated' : 'Platform user created')
      navigate('/platform/super-admins')
    } catch (err: any) {
      setError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Unable to create the user. Please check the details and try again.')
    } finally { setSaving(false) }
  }
  const inputClass = 'mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
  return (
    <form onSubmit={submit} className="page-body space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-slate-500"><button type="button" onClick={() => navigate('/platform/super-admins')} className="hover:text-slate-800">Platform Users</button><ChevronRight size={12} className="text-slate-300" /><span aria-current="page" className="font-medium text-slate-700">{isEdit ? 'Edit User' : 'New User'}</span></nav><h2 className="page-title mt-2">{isEdit ? 'Edit Platform User' : 'Create New Platform User'}</h2></div>
        <div className="flex gap-2"><button type="button" className="btn btn-outline" onClick={() => navigate('/platform/super-admins')}>Cancel</button><button type="submit" disabled={saving || loading || loadFailed} className="btn btn-primary disabled:opacity-50">{saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Platform User'}</button></div>
      </div>
      {error && <p role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="mb-5 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><UserRound size={19} /></span><h3 className="font-bold text-slate-900">Personal Information</h3></div><div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm font-medium text-slate-600">Username <span className="text-red-500">*</span><input className={inputClass} value={form.username} onChange={event => set('username', event.target.value)} readOnly={isEdit} required maxLength={100} autoComplete="off" /></label>
        <label className="text-sm font-medium text-slate-600">Full Name <span className="text-red-500">*</span><input className={inputClass} value={form.full_name} onChange={event => set('full_name', event.target.value)} required maxLength={200} /></label>
        <label className="text-sm font-medium text-slate-600">Email <span className="text-red-500">*</span><input className={inputClass} value={form.email} onChange={event => set('email', event.target.value)} type="email" required maxLength={200} /></label>
      </div></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="mb-5 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><ShieldCheck size={19} /></span><h3 className="font-bold text-slate-900">Platform Access</h3></div><div className="grid items-end gap-4 md:grid-cols-3"><div><p className="text-sm font-medium text-slate-600">Role</p><div className="mt-2 flex h-11 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-800"><ShieldCheck size={16} className="text-blue-600" /> Super Admin</div></div><div className="rounded-xl bg-slate-50 p-4 md:col-span-2"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Access Level</p><p className="mt-1 text-sm text-slate-700">Full access to the platform administration console.</p></div></div></section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="mb-5 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><LockKeyhole size={19} /></span><h3 className="font-bold text-slate-900">Security</h3></div><label htmlFor="platform-user-password" className="text-sm font-medium text-slate-600">{isEdit ? 'New Password (optional)' : 'Password'} {!isEdit && <span className="text-red-500">*</span>}</label><div className="relative max-w-lg"><input id="platform-user-password" className={`${inputClass} pr-12`} type={showPassword ? 'text' : 'password'} value={form.password} onChange={event => set('password', event.target.value)} required={!isEdit} autoComplete="new-password" placeholder="Enter a strong password" /><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} className="absolute bottom-0 right-0 flex h-11 items-center px-4 text-slate-400">{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><p className="mt-3 text-xs text-slate-500">Use at least 8 characters, including uppercase and lowercase letters, a number and a special character.</p></section>
    </form>
  )
}
