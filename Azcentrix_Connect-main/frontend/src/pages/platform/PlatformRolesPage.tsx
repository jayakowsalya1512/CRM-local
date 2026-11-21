import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'
import { isApprovalQueued, platformApi, type PlatformAccessLevel, type PlatformModule, type PlatformTeamRole } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import PlatformTeamTabs, {
  Pill, TeamModal, TeamPanel, apiError, buttonClass, fieldLabelClass, inputClass,
  primaryButtonClass, smallButtonClass, smallPrimaryButtonClass,
} from '@/components/platform/PlatformTeamTabs'
import { notifyPlatformAccessChanged, usePlatformAccess } from '@/components/platform/usePlatformAccess'

const LEVELS: { value: PlatformAccessLevel; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'view', label: 'View' },
  { value: 'manage', label: 'Manage' },
]
type Draft = Record<string, PlatformAccessLevel>

export default function PlatformRolesPage() {
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const { me } = usePlatformAccess()
  const canEdit = !!me?.is_super_admin
  const [modules, setModules] = useState<PlatformModule[]>([])
  const [roles, setRoles] = useState<PlatformTeamRole[]>([])
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await platformApi.listTeamRoles()
      setModules(data.modules)
      setRoles(data.roles)
    } catch (err) {
      toastRef.current.error(apiError(err, 'Unable to load roles'))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const levelOf = (role: PlatformTeamRole, module: string) => drafts[role.id]?.[module] ?? role.permissions[module] ?? 'none'
  const isDirty = (role: PlatformTeamRole) => !!drafts[role.id] && modules.some(m => drafts[role.id][m.key] !== undefined && drafts[role.id][m.key] !== role.permissions[m.key])
  const setLevel = (role: PlatformTeamRole, module: string, level: PlatformAccessLevel) =>
    setDrafts(prev => ({ ...prev, [role.id]: { ...prev[role.id], [module]: level } }))
  const discard = (role: PlatformTeamRole) => setDrafts(prev => {
    const next = { ...prev }
    delete next[role.id]
    return next
  })

  const save = async (role: PlatformTeamRole) => {
    setSavingId(role.id)
    try {
      const permissions = Object.fromEntries(modules.map(m => [m.key, levelOf(role, m.key)])) as Draft
      const { data } = await platformApi.updateTeamRole(role.id, { permissions })
      if (isApprovalQueued(data)) toast.info('Sent for approval', data.message)
      else toast.success(`${role.name} updated`)
      discard(role)
      notifyPlatformAccessChanged()
      await load()
    } catch (err) {
      toast.error(apiError(err, 'Unable to save this role'))
    } finally {
      setSavingId(null)
    }
  }

  const remove = async (role: PlatformTeamRole) => {
    if (!window.confirm(`Delete the ${role.name} role?`)) return
    try {
      await platformApi.deleteTeamRole(role.id)
      toast.success(`${role.name} deleted`)
      await load()
    } catch (err) {
      toast.error(apiError(err, 'Unable to delete this role'))
    }
  }

  return (
    <PlatformTeamTabs
      title="Platform roles"
      action={canEdit && <button type="button" className={primaryButtonClass} onClick={() => setCreating(true)}><Plus size={15} /> New role</button>}
    >
      <TeamPanel title="Permission matrix">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left">
            <thead>
              <tr>
                <th>Role</th>
                {modules.map(module => <th key={module.key} className="text-center">{module.label}</th>)}
                <th className="w-[150px]"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={modules.length + 2} className="!py-6 text-center text-[var(--bw-mu)]">Loading roles…</td></tr>
              ) : roles.map(role => {
                const locked = !canEdit || role.is_super_admin || !!role.pending_request_id
                const dirty = isDirty(role)
                return (
                  <tr key={role.id}>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <b className="font-semibold">{role.name}</b>
                        <span className="text-[11px] text-[var(--bw-mu)]">{role.staff_count} staff</span>
                        {role.pending_request_id && <Pill tone="wa" title="A change to this role is waiting for approval">#{role.pending_request_id} pending</Pill>}
                      </div>
                    </td>
                    {modules.map(module => (
                      <td key={module.key} className="text-center">
                        <select
                          aria-label={`${role.name}: ${module.label}`}
                          value={levelOf(role, module.key)}
                          disabled={locked}
                          title={role.is_super_admin ? 'Super admin always has full access' : !canEdit ? 'Only a Super admin can change roles' : undefined}
                          onChange={event => setLevel(role, module.key, event.target.value as PlatformAccessLevel)}
                          className={`${inputClass} !h-6 !w-[84px] !px-1 text-[12px] ${drafts[role.id]?.[module.key] !== undefined && drafts[role.id][module.key] !== role.permissions[module.key] ? '!border-[var(--bw-ac)] font-medium' : ''}`}
                        >
                          {LEVELS.map(level => <option key={level.value} value={level.value}>{level.label}</option>)}
                        </select>
                      </td>
                    ))}
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        {dirty && <>
                          <button type="button" className={smallButtonClass} onClick={() => discard(role)} disabled={savingId !== null}>Discard</button>
                          <button type="button" className={smallPrimaryButtonClass} onClick={() => save(role)} disabled={savingId !== null}>
                            {savingId === role.id && <Loader2 size={11} className="animate-spin" />}Save
                          </button>
                        </>}
                        {!dirty && canEdit && !role.is_system && role.staff_count === 0 && (
                          <button type="button" onClick={() => remove(role)} aria-label={`Delete ${role.name}`} title="Delete role" className="grid h-6 w-6 place-items-center rounded-md text-[var(--bw-mu)] hover:bg-[var(--bw-hd)] hover:text-[var(--bw-ba)]">
                            <Trash2 size={14} />
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
        <p className="border-t border-[var(--bw-ln)] px-2.5 py-1.5 text-[11px] text-[var(--bw-mu)]">
          View lets staff open an area; Manage lets them change it. The server enforces these on every request.
          {canEdit ? (me?.four_eyes_enabled ? ' With four-eyes on, saved changes wait for a second approver.' : '') : ' Only a Super admin can change roles.'}
        </p>
      </TeamPanel>

      {creating && <NewRoleModal roles={roles} onClose={() => setCreating(false)} onDone={name => { setCreating(false); toast.success(`${name} created`); void load() }} />}
    </PlatformTeamTabs>
  )
}

function NewRoleModal({ roles, onClose, onDone }: { roles: PlatformTeamRole[]; onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true); setError('')
    try {
      const source = roles.find(role => String(role.id) === copyFrom)
      const { data } = await platformApi.createTeamRole({ name: name.trim(), permissions: source?.permissions })
      onDone(data.name)
    } catch (err) {
      setError(apiError(err, 'Unable to create the role'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TeamModal title="New role" onClose={onClose} onSubmit={submit} width={400} footer={<>
      <button type="button" className={buttonClass} onClick={onClose}>Cancel</button>
      <button type="submit" className={primaryButtonClass} disabled={saving}>{saving && <Loader2 size={13} className="animate-spin" />}Create role</button>
    </>}>
      {error && <p role="alert" className="mb-2.5 text-[12px] text-[var(--bw-ba)]">{error}</p>}
      <div className="grid gap-2.5">
        <div><label className={fieldLabelClass} htmlFor="role-name">Role name</label><input id="role-name" autoFocus className={inputClass} value={name} onChange={e => setName(e.target.value)} maxLength={80} required placeholder="e.g. Solutions engineer" /></div>
        <div>
          <label className={fieldLabelClass} htmlFor="role-copy">Start from</label>
          <select id="role-copy" className={inputClass} value={copyFrom} onChange={e => setCopyFrom(e.target.value)}>
            <option value="">No access</option>
            {roles.filter(role => !role.is_super_admin).map(role => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
        </div>
      </div>
    </TeamModal>
  )
}
