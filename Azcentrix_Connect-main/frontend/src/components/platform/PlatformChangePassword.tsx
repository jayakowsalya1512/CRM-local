import { useEffect, useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'
import { platformApi } from '@/services/platformApi'
import { useToast } from '@/components/ui/ToastContext'

export default function PlatformChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [visible, setVisible] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const { success } = useToast()

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [onClose, saving])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (password !== confirm) { setError('New passwords do not match.'); return }
    setError('')
    setSaving(true)
    try {
      await platformApi.changePassword({ current_password: current, new_password: password, confirm_password: confirm })
      success('Password changed successfully')
      onClose()
    } catch (err: any) {
      setError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Unable to change password. Please try again.')
    } finally { setSaving(false) }
  }

  const fields = [
    { id: 'current', label: 'Current Password', value: current, set: setCurrent, autoComplete: 'current-password' },
    { id: 'new', label: 'New Password', value: password, set: setPassword, autoComplete: 'new-password' },
    { id: 'confirm', label: 'Confirm New Password', value: confirm, set: setConfirm, autoComplete: 'new-password' },
  ]

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="platform-password-title" className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div><h2 id="platform-password-title" className="text-xl font-bold text-slate-900">Change Password</h2><p className="mt-1 text-sm text-slate-500">Enter your current password to set a new one.</p></div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100"><X size={20} /></button>
        </div>
        <form onSubmit={submit} className="mt-4 space-y-3">
          {fields.map(field => (
            <div key={field.id}>
              <label htmlFor={`platform-password-${field.id}`} className="mb-1.5 block text-sm font-semibold text-slate-600">{field.label}</label>
              <div className="relative">
                <input id={`platform-password-${field.id}`} type={visible[field.id] ? 'text' : 'password'} value={field.value} onChange={event => field.set(event.target.value)} autoComplete={field.autoComplete} required autoFocus={field.id === 'current'} className="h-10 w-full rounded-xl border border-slate-200 bg-white px-4 pr-12 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
                <button type="button" onClick={() => setVisible(value => ({ ...value, [field.id]: !value[field.id] }))} aria-label={`${visible[field.id] ? 'Hide' : 'Show'} ${field.label.toLowerCase()}`} className="absolute inset-y-0 right-0 flex items-center px-4 text-slate-400 hover:text-slate-600">{visible[field.id] ? <EyeOff size={17} /> : <Eye size={17} />}</button>
              </div>
            </div>
          ))}
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} disabled={saving} className="h-10 flex-1 rounded-xl border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving} className="h-10 flex-1 rounded-xl bg-blue-600 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{saving ? 'Saving...' : 'Save Password'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
