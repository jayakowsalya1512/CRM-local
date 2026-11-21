import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Loader2, Plus, Search } from 'lucide-react'
import {
  isApprovalQueued, platformApi,
  type PlatformOtpMode, type PlatformStaff, type PlatformTeamRole, type PlatformTenant,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import PlatformTeamTabs, {
  Pill, TeamModal, TeamPanel, apiError, buttonClass, fieldLabelClass, formatDate, formatDateTime, inputClass,
  primaryButtonClass, smallButtonClass, smallDangerButtonClass,
} from '@/components/platform/PlatformTeamTabs'
import { notifyPlatformAccessChanged, usePlatformAccess } from '@/components/platform/usePlatformAccess'
import { usePlatformAuthStore } from '@/store/platformAuthStore'

type Scope = 'all' | 'assigned'
type AccessForm = { role_id: number; scope: Scope; tenant_ids: number[] }
const RANK = { none: 0, view: 1, manage: 2 } as const

export default function PlatformSuperAdminsPage() {
  const toast = useToast()
  const { me, can } = usePlatformAccess()
  const { user: currentUser } = usePlatformAuthStore()
  const [staff, setStaff] = useState<PlatformStaff[]>([])
  const [roles, setRoles] = useState<PlatformTeamRole[]>([])
  const [tenants, setTenants] = useState<PlatformTenant[]>([])
  const [otpMode, setOtpMode] = useState<PlatformOtpMode>('never')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<PlatformStaff | null>(null)
  const [accessFor, setAccessFor] = useState<PlatformStaff | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const canManage = can('team', 'manage')

  // The toast context value changes on every toast, so keep it out of effect deps.
  const toastRef = useRef(toast)
  toastRef.current = toast
  const load = useCallback(async () => {
    try {
      const { data } = await platformApi.listStaff()
      setStaff(data)
    } catch (err) {
      toastRef.current.error(apiError(err, 'Unable to load staff'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    platformApi.loginOptions().then(({ data }) => setOtpMode(data.otp_mode ?? 'never')).catch(() => {})
    platformApi.listTeamRoles().then(({ data }) => setRoles(data.roles)).catch(() => {})
    platformApi.listTenants().then(({ data }) => setTenants(data)).catch(() => {})
  }, [load])

  // Non-super staff may only hand out roles that fit inside their own access.
  const assignableRoles = useMemo(() => roles.filter(role =>
    me?.is_super_admin || (!role.is_super_admin && Object.entries(role.permissions).every(([module, level]) => RANK[level] <= RANK[me?.permissions[module] ?? 'none']))
  ), [roles, me])
  const canManageAccount = (row: PlatformStaff) => {
    if (!canManage) return false
    if (me?.is_super_admin) return true
    const role = roles.find(r => r.id === row.role_id)
    return !row.is_super_admin && !!role && assignableRoles.includes(role)
  }

  const afterChange = (data: unknown, fallback: string) => {
    if (isApprovalQueued(data)) toast.info('Sent for approval', data.message)
    else toast.success(fallback)
    notifyPlatformAccessChanged()
    void load()
  }

  const toggleActive = async (row: PlatformStaff) => {
    const name = row.full_name || row.username
    if (row.is_active && !window.confirm(`Deactivate ${name}? They lose access to the platform console immediately.`)) return
    setBusyId(row.id)
    try {
      const { data } = row.is_active ? await platformApi.deactivateSuperAdmin(row.id) : await platformApi.activateSuperAdmin(row.id)
      afterChange(data, `${name} ${row.is_active ? 'deactivated' : 'activated'}`)
    } catch (err) {
      toast.error(apiError(err, 'Action failed'))
    } finally {
      setBusyId(null)
    }
  }

  const resendInvite = async (row: PlatformStaff) => {
    setBusyId(row.id)
    try {
      const { data } = await platformApi.resendStaffInvite(row.id)
      toast.success(data.message)
    } catch (err) {
      toast.error(apiError(err, 'Unable to send the invitation'))
    } finally {
      setBusyId(null)
    }
  }

  const term = search.trim().toLowerCase()
  const filtered = staff.filter(row => !term || `${row.full_name} ${row.username} ${row.email} ${row.role_name}`.toLowerCase().includes(term))
  const mfaLabel = otpMode === 'every_login' ? 'Yes' : otpMode === 'new_device' ? 'New device' : 'No'

  return (
    <PlatformTeamTabs
      title="Platform users"
      action={canManage && <button type="button" className={primaryButtonClass} onClick={() => setInviting(true)}><Plus size={15} /> Invite staff</button>}
    >
      <TeamPanel
        title="Staff"
        actions={
          <div className="relative w-[220px] max-w-[50vw]">
            <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--bw-mu)]" />
            <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter staff…" aria-label="Filter staff" className={`${inputClass} h-6 pl-7 text-[12px]`} />
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] table-fixed text-left">
            <thead>
              <tr>
                <th className="w-[18%]">Name</th>
                <th className="w-[19%]">Email</th>
                <th className="w-[12%]">Role</th>
                <th className="w-[12%]">Scope</th>
                <th className="w-[6%]">MFA</th>
                <th className="w-[11%]">Last sign-in</th>
                <th className="w-[22%] text-right"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="!py-6 text-center text-[var(--bw-mu)]">Loading staff…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="!py-6 text-center text-[var(--bw-mu)]">{term ? 'No staff match this filter.' : 'No staff yet.'}</td></tr>
              ) : filtered.map(row => {
                const name = row.full_name || row.username
                const isMe = row.username === currentUser?.username
                const manageable = canManageAccount(row) && !isMe
                return (
                  <tr key={row.id} className={row.is_active ? '' : 'opacity-60'}>
                    <td>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="grid h-5 w-5 flex-none place-items-center rounded-full text-[9px] font-semibold text-white" style={{ background: avatarColor(name) }}>{initialsOf(name)}</span>
                        <span className="truncate">{name}</span>
                        {isMe && <span className="text-[11px] text-[var(--bw-mu)]">(you)</span>}
                      </div>
                    </td>
                    <td className="truncate" title={row.email}>{row.email}</td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1">
                        <Pill>{row.role_name}</Pill>
                        {!row.is_active && <Pill tone="mu">Inactive</Pill>}
                        {row.pending_request_id && <Pill tone="wa" title="A change to this account is waiting for approval">#{row.pending_request_id} pending</Pill>}
                      </div>
                    </td>
                    <td className="truncate" title={row.tenant_names.join(', ')}>
                      {row.scope === 'all' ? 'All tenants' : `${row.tenant_names.length} assigned tenant${row.tenant_names.length === 1 ? '' : 's'}`}
                    </td>
                    <td>{mfaLabel}</td>
                    <td className="truncate" title={row.last_sign_in ? formatDateTime(row.last_sign_in) : undefined}>{row.last_sign_in ? formatDate(row.last_sign_in) : <span className="text-[var(--bw-mu)]">Never</span>}</td>
                    <td className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {(manageable || isMe) && <button type="button" className={smallButtonClass} onClick={() => setEditing(row)}>Edit</button>}
                        {manageable && <button type="button" className={smallButtonClass} onClick={() => setAccessFor(row)}>Access</button>}
                        {manageable && row.is_active && !row.last_sign_in && me?.invite_email_available && (
                          <button type="button" className={smallButtonClass} disabled={busyId !== null} onClick={() => resendInvite(row)}>Resend</button>
                        )}
                        {manageable && (
                          <button type="button" className={row.is_active ? smallDangerButtonClass : smallButtonClass} disabled={busyId !== null} onClick={() => toggleActive(row)}>
                            {busyId === row.id && <Loader2 size={11} className="animate-spin" />}{row.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </TeamPanel>
      {me?.four_eyes_enabled && (
        <p className="mt-2 rounded-md border border-[color-mix(in_srgb,var(--bw-ac)_30%,var(--bw-ln))] bg-[color-mix(in_srgb,var(--bw-ac)_8%,var(--bw-sf))] px-2.5 py-1.5 text-[12px] text-[var(--bw-tx)]">
          Four-eyes approval is on. Role or scope changes and deactivations wait in the approval queue until another staff member approves them.
        </p>
      )}

      {inviting && (
        <InviteModal roles={assignableRoles} tenants={tenants} emailAvailable={!!me?.invite_email_available}
          onClose={() => setInviting(false)} onDone={message => { setInviting(false); toast.success(message); void load() }} />
      )}
      {editing && (
        <ProfileModal staff={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); toast.success('Staff details saved'); void load() }} />
      )}
      {accessFor && (
        <AccessModal staff={accessFor} roles={assignableRoles} tenants={tenants}
          onClose={() => setAccessFor(null)} onDone={data => { setAccessFor(null); afterChange(data, 'Access updated') }} />
      )}
    </PlatformTeamTabs>
  )
}

function AccessFields({ value, onChange, roles, tenants }: { value: AccessForm; onChange: (next: AccessForm) => void; roles: PlatformTeamRole[]; tenants: PlatformTenant[] }) {
  const role = roles.find(r => r.id === value.role_id)
  const toggleTenant = (id: number) => onChange({ ...value, tenant_ids: value.tenant_ids.includes(id) ? value.tenant_ids.filter(t => t !== id) : [...value.tenant_ids, id] })
  return (
    <>
      <div className="col-span-2">
        <label className={fieldLabelClass} htmlFor="staff-role">Role</label>
        <select id="staff-role" className={inputClass} value={value.role_id || ''} onChange={event => onChange({ ...value, role_id: Number(event.target.value) })} required>
          <option value="" disabled>Choose a role</option>
          {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <fieldset className="col-span-2" disabled={role?.is_super_admin}>
        <legend className={fieldLabelClass}>Tenant scope</legend>
        <div className="flex gap-4 text-[13px]">
          {(['all', 'assigned'] as Scope[]).map(scope => (
            <label key={scope} className="inline-flex items-center gap-1.5 !text-[var(--bw-tx)]">
              <input type="radio" name="staff-scope" checked={(role?.is_super_admin ? 'all' : value.scope) === scope} onChange={() => onChange({ ...value, scope })} />
              {scope === 'all' ? 'All tenants' : 'Assigned tenants only'}
            </label>
          ))}
        </div>
        {role?.is_super_admin && <p className="mt-1 text-[11px] text-[var(--bw-mu)]">Super admins always cover every tenant.</p>}
        {!role?.is_super_admin && value.scope === 'assigned' && (
          <div className="mt-1.5 max-h-[160px] overflow-y-auto rounded-md border border-[var(--bw-ln)]">
            {tenants.length === 0 && <p className="px-2.5 py-2 text-[12px] text-[var(--bw-mu)]">No tenants available.</p>}
            {tenants.map(tenant => (
              <label key={tenant.id} className="flex items-center gap-2 border-b border-[var(--bw-ln2)] px-2.5 py-1 text-[13px] !text-[var(--bw-tx)] last:border-b-0 hover:bg-[var(--bw-hd)]">
                <input type="checkbox" checked={value.tenant_ids.includes(tenant.id)} onChange={() => toggleTenant(tenant.id)} />
                <span className="truncate">{tenant.name}</span>
                <span className="ml-auto text-[11px] text-[var(--bw-mu)]">{tenant.slug}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </>
  )
}

function InviteModal({ roles, tenants, emailAvailable, onClose, onDone }: {
  roles: PlatformTeamRole[]; tenants: PlatformTenant[]; emailAvailable: boolean; onClose: () => void; onDone: (message: string) => void
}) {
  const [form, setForm] = useState({ full_name: '', username: '', email: '', password: '' })
  const [access, setAccess] = useState<AccessForm>({ role_id: roles.find(r => r.key === 'read_only_auditor')?.id ?? 0, scope: 'all', tenant_ids: [] })
  const [delivery, setDelivery] = useState<'email' | 'password'>(emailAvailable ? 'email' : 'password')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm(prev => ({ ...prev, [key]: event.target.value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (access.scope === 'assigned' && access.tenant_ids.length === 0) { setError('Choose at least one tenant, or give access to all tenants.'); return }
    setSaving(true); setError('')
    try {
      const { data } = await platformApi.inviteStaff({ ...form, ...access, password: delivery === 'password' ? form.password : undefined })
      onDone(data.message)
    } catch (err) {
      setError(apiError(err, 'Unable to invite this person'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TeamModal title="Invite staff" onClose={onClose} onSubmit={submit} width={520} footer={<>
      <button type="button" className={buttonClass} onClick={onClose}>Cancel</button>
      <button type="submit" className={primaryButtonClass} disabled={saving}>{saving && <Loader2 size={13} className="animate-spin" />}{delivery === 'email' ? 'Send invitation' : 'Create account'}</button>
    </>}>
      {error && <p role="alert" className="mb-2.5 rounded-md border border-[color-mix(in_srgb,var(--bw-ba)_35%,var(--bw-ln))] bg-[color-mix(in_srgb,var(--bw-ba)_8%,var(--bw-sf))] px-2.5 py-1.5 text-[12px] text-[var(--bw-ba)]">{error}</p>}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <div className="col-span-2"><label className={fieldLabelClass} htmlFor="invite-name">Full name</label><input id="invite-name" className={inputClass} value={form.full_name} onChange={set('full_name')} required maxLength={100} autoFocus /></div>
        <div><label className={fieldLabelClass} htmlFor="invite-username">Username</label><input id="invite-username" className={inputClass} value={form.username} onChange={set('username')} required maxLength={100} autoComplete="off" /></div>
        <div><label className={fieldLabelClass} htmlFor="invite-email">Email</label><input id="invite-email" type="email" className={inputClass} value={form.email} onChange={set('email')} required /></div>
        <AccessFields value={access} onChange={setAccess} roles={roles} tenants={tenants} />
        <fieldset className="col-span-2">
          <legend className={fieldLabelClass}>How they sign in</legend>
          <div className="flex flex-wrap gap-4 text-[13px]">
            <label className={`inline-flex items-center gap-1.5 !text-[var(--bw-tx)] ${emailAvailable ? '' : 'opacity-50'}`} title={emailAvailable ? undefined : 'Email isn’t configured on this server'}>
              <input type="radio" name="invite-delivery" disabled={!emailAvailable} checked={delivery === 'email'} onChange={() => setDelivery('email')} /> Email a set-password link
            </label>
            <label className="inline-flex items-center gap-1.5 !text-[var(--bw-tx)]">
              <input type="radio" name="invite-delivery" checked={delivery === 'password'} onChange={() => setDelivery('password')} /> Set a temporary password
            </label>
          </div>
          {delivery === 'password' && (
            <>
              <input type="password" className={`${inputClass} mt-1.5`} value={form.password} onChange={set('password')} required autoComplete="new-password" aria-label="Temporary password" placeholder="Temporary password" />
              <p className="mt-1 text-[11px] text-[var(--bw-mu)]">They must change it at first sign-in. Share it with them securely.</p>
            </>
          )}
          {delivery === 'email' && <p className="mt-1 text-[11px] text-[var(--bw-mu)]">The link expires in 72 hours.</p>}
        </fieldset>
      </div>
    </TeamModal>
  )
}

function AccessModal({ staff, roles, tenants, onClose, onDone }: {
  staff: PlatformStaff; roles: PlatformTeamRole[]; tenants: PlatformTenant[]; onClose: () => void; onDone: (data: unknown) => void
}) {
  const [access, setAccess] = useState<AccessForm>({ role_id: staff.role_id, scope: staff.scope, tenant_ids: staff.tenant_ids })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const options = roles.some(r => r.id === staff.role_id) ? roles : [{ id: staff.role_id, name: staff.role_name } as PlatformTeamRole, ...roles]

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (access.scope === 'assigned' && access.tenant_ids.length === 0) { setError('Choose at least one tenant, or give access to all tenants.'); return }
    setSaving(true); setError('')
    try {
      const { data } = await platformApi.updateStaffAccess(staff.id, access)
      onDone(data)
    } catch (err) {
      setError(apiError(err, 'Unable to change access'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TeamModal title={`Access for ${staff.full_name || staff.username}`} onClose={onClose} onSubmit={submit} width={480} footer={<>
      <button type="button" className={buttonClass} onClick={onClose}>Cancel</button>
      <button type="submit" className={primaryButtonClass} disabled={saving}>{saving && <Loader2 size={13} className="animate-spin" />}Save access</button>
    </>}>
      {error && <p role="alert" className="mb-2.5 rounded-md border border-[color-mix(in_srgb,var(--bw-ba)_35%,var(--bw-ln))] bg-[color-mix(in_srgb,var(--bw-ba)_8%,var(--bw-sf))] px-2.5 py-1.5 text-[12px] text-[var(--bw-ba)]">{error}</p>}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <AccessFields value={access} onChange={setAccess} roles={options} tenants={tenants} />
      </div>
    </TeamModal>
  )
}

function ProfileModal({ staff, onClose, onDone }: { staff: PlatformStaff; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ full_name: staff.full_name, email: staff.email, password: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const updates: { full_name?: string; email?: string; password?: string } = {}
    if (form.full_name.trim() !== staff.full_name) updates.full_name = form.full_name.trim()
    if (form.email.trim() !== staff.email) updates.email = form.email.trim()
    if (form.password) updates.password = form.password
    if (Object.keys(updates).length === 0) { onClose(); return }
    setSaving(true); setError('')
    try {
      await platformApi.updateSuperAdmin(staff.id, updates)
      onDone()
    } catch (err) {
      setError(apiError(err, 'Unable to save'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TeamModal title={`Edit ${staff.username}`} onClose={onClose} onSubmit={submit} width={440} footer={<>
      <button type="button" className={buttonClass} onClick={onClose}>Cancel</button>
      <button type="submit" className={primaryButtonClass} disabled={saving}>{saving && <Loader2 size={13} className="animate-spin" />}Save</button>
    </>}>
      {error && <p role="alert" className="mb-2.5 rounded-md border border-[color-mix(in_srgb,var(--bw-ba)_35%,var(--bw-ln))] bg-[color-mix(in_srgb,var(--bw-ba)_8%,var(--bw-sf))] px-2.5 py-1.5 text-[12px] text-[var(--bw-ba)]">{error}</p>}
      <div className="grid gap-2.5">
        <div><label className={fieldLabelClass} htmlFor="edit-name">Full name</label><input id="edit-name" className={inputClass} value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} required maxLength={100} /></div>
        <div><label className={fieldLabelClass} htmlFor="edit-email">Email</label><input id="edit-email" type="email" className={inputClass} value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required /></div>
        <div><label className={fieldLabelClass} htmlFor="edit-password">New password <span className="text-[11px]">(leave blank to keep)</span></label><input id="edit-password" type="password" className={inputClass} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} autoComplete="new-password" /></div>
      </div>
    </TeamModal>
  )
}

const AVATAR_COLORS = ['#5646C2', '#1B8559', '#C13B2A', '#2F6DB5', '#B26B00', '#7A4FB8']
function avatarColor(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}
function initialsOf(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
}
