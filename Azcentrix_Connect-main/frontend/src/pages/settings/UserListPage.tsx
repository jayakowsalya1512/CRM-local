import { useState, useEffect, useMemo } from 'react'
import {
  Users, Plus, Edit2, ToggleLeft, ToggleRight, Key,
  ShieldCheck, Crown, TrendingUp, Calculator, Headphones, UserCog,
  MapPin, Users2, Building2, Check, Search, Target, LogOut, RefreshCw,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import api, { authApi } from '@/services/api'
import Button from '@/components/ui/Button'
import DataTable from '@/components/ui/DataTable'
import { Modal } from '@/components/ui/Modal'
import SlidePanel from '@/components/ui/SlidePanel'
import Input from '@/components/ui/Input'
import {
  PageHeader, StatCard, useToast,
} from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { StatusBadge } from '@/components/ui/DataTable'
import { useAuthStore } from '@/store'
import { confirmActionWithCheckbox } from '@/utils/sweetAlert'

// ─── Role config ──────────────────────────────────────────────────────────────

type RoleConfig = { label: string; color: string; bg: string; border: string; icon: React.ReactNode }

interface RoleDefinition {
  id: number
  name: string
  display_name?: string | null
  level?: number | null
  description?: string | null
  is_active?: boolean
  permission_count?: number | null
}

type UserGroupDisplay = { id?: number | string; name: string }

const ROLE_CONFIG: Record<string, RoleConfig> = {
  admin:       { label: 'Admin',         color: 'text-violet-700',  bg: 'bg-violet-100',  border: 'border-violet-200',  icon: <ShieldCheck size={11} /> },
  ceo:         { label: 'CEO',           color: 'text-sky-700',     bg: 'bg-sky-100',     border: 'border-sky-200',     icon: <Crown size={11} /> },
  project_lead:{ label: 'Project Lead',  color: 'text-cyan-700',    bg: 'bg-cyan-100',    border: 'border-cyan-200',    icon: <ShieldCheck size={11} /> },
  vp:          { label: 'Vice President',color: 'text-indigo-700',  bg: 'bg-indigo-100',  border: 'border-indigo-200',  icon: <Crown size={11} /> },
  manager:     { label: 'Sales Head',    color: 'text-purple-700',  bg: 'bg-purple-100',  border: 'border-purple-200',  icon: <UserCog size={11} /> },
  sales:       { label: 'Sales Executive', color: 'text-emerald-700', bg: 'bg-emerald-100', border: 'border-emerald-200', icon: <TrendingUp size={11} /> },
  accounts:    { label: 'Accounts',      color: 'text-amber-700',   bg: 'bg-amber-100',   border: 'border-amber-200',   icon: <Calculator size={11} /> },
  support:     { label: 'Support',       color: 'text-pink-700',    bg: 'bg-pink-100',    border: 'border-pink-200',    icon: <Headphones size={11} /> },
}

const DEFAULT_ROLE_OPTIONS = [
  { value: 'admin',       label: 'Admin',         subtitle: 'Full system access' },
  { value: 'ceo',         label: 'CEO',           subtitle: 'All operations' },
  { value: 'project_lead', label: 'Project Lead', subtitle: 'Project approvals and tracking' },
  { value: 'vp',          label: 'Vice President', subtitle: 'Vice President' },
  { value: 'manager',     label: 'Sales Head',    subtitle: 'Team + reports' },
  { value: 'sales',       label: 'Sales Executive', subtitle: 'Own leads & customers' },
  { value: 'accounts',    label: 'Accounts',      subtitle: 'Finance & reports' },
  { value: 'support',     label: 'Support',       subtitle: 'View only' },
]

const ADMIN_ROLES           = ['admin', 'ceo', 'manager']
const CUSTOMER_ASSIGN_ROLES = ['vp', 'manager', 'sales', 'support', 'accounts']

function humanizeRoleName(role: string) {
  return role
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeRoleDefinitions(data: unknown): RoleDefinition[] {
  const roles = Array.isArray(data) ? data : []
  return roles
    .filter((role): role is RoleDefinition =>
      !!role && typeof role === 'object' && typeof (role as RoleDefinition).name === 'string'
    )
    .sort((a, b) => {
      const levelA = Number(a.level ?? 999)
      const levelB = Number(b.level ?? 999)
      if (levelA !== levelB) return levelA - levelB
      return (a.display_name || a.name).localeCompare(b.display_name || b.name)
    })
}

function buildLatestKamTargetMap(rows: any[]): Map<number, number> {
  const sorted = [...rows].sort((a, b) => {
    const periodA = String(a?.period ?? '')
    const periodB = String(b?.period ?? '')
    if (periodA !== periodB) return periodB.localeCompare(periodA)
    return Number(b?.id ?? 0) - Number(a?.id ?? 0)
  })

  const map = new Map<number, number>()
  for (const row of sorted) {
    const userId = Number(row?.user_id)
    const salesTarget = Number(row?.sales_target ?? 0)
    if (!userId || map.has(userId) || salesTarget <= 0) continue
    map.set(userId, salesTarget)
  }
  return map
}

// ─── RoleBadge ────────────────────────────────────────────────────────────────

function formatCompactTarget(value: unknown) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return ''
  const compact = (num: number) => Number.isInteger(num) ? String(num) : num.toFixed(1).replace(/\.0$/, '')
  if (amount >= 10000000) return `₹${compact(amount / 10000000)}c`
  if (amount >= 100000) return `₹${compact(amount / 100000)}l`
  if (amount >= 1000) return `₹${compact(amount / 1000)}k`
  return `₹${amount.toLocaleString('en-IN')}`
}

function normalizeUserGroups(row: any): UserGroupDisplay[] {
  const mappedGroups = Array.isArray(row?.groups) ? row.groups : []
  const groups = mappedGroups
    .map((group: any) => ({
      id:   group?.id,
      name: String(group?.name || group?.group_name || '').trim(),
    }))
    .filter((group: UserGroupDisplay) => Boolean(group.name))

  if (groups.length) return groups

  const groupName = String(row?.group_name || '').trim()
  if (!groupName) return []

  return groupName
    .split(',')
    .map((name, index) => ({ id: `${name.trim()}-${index}`, name: name.trim() }))
    .filter(group => Boolean(group.name))
}

function RoleBadge({ role, label }: { role?: string | null; label?: string }) {
  const roleName = String(role ?? '')
  const cfg = ROLE_CONFIG[roleName]
  const displayLabel = label || cfg?.label || (roleName ? humanizeRoleName(roleName) : 'No Role')
  if (!cfg) {
    return (
      <span className="inline-flex max-w-full items-start gap-1 rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-semibold leading-4 text-gray-600">
        <ShieldCheck size={11} className="mt-0.5 flex-shrink-0" />
        <span className="min-w-0 whitespace-normal break-words">{displayLabel}</span>
      </span>
    )
  }
  return (
    <span className={`inline-flex max-w-full items-start gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold leading-4 ${cfg.bg} ${cfg.color} ${cfg.border}`}>
      <span className="mt-0.5 flex-shrink-0">{cfg.icon}</span>
      <span className="min-w-0 whitespace-normal break-words">{displayLabel}</span>
    </span>
  )
}

function strVal(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'target' in v)
    return (v as React.ChangeEvent<HTMLInputElement>).target.value
  return ''
}

const emptyResetPasswordForm = () => ({
  new_password: '',
  confirm_password: '',
})

// ─── Customer Assignment Panel ────────────────────────────────────────────────

function CustomerAssignPanel({
  user,
  onClose,
  getRoleLabel,
}: {
  user: any
  onClose: () => void
  getRoleLabel: (role?: string | null) => string
}) {
  const [availableCustomers, setAvailableCustomers] = useState<any[]>([])
  const [assignedIds, setAssignedIds]               = useState<Set<number>>(new Set())
  const [directAssignedMap, setDirectAssignedMap]   = useState<Map<number, number | null>>(new Map())
  const [search, setSearch]                         = useState('')
  const [loading, setLoading]                       = useState(true)
  const [saving, setSaving]                         = useState(false)
  const { success, error: showError }               = useToast()

  useEffect(() => {
    const init = async () => {
      setLoading(true)
      try {
        const [availRes, assignedRes, customerListRes] = await Promise.all([
          api.get(`/auth/users/${user.id}/available-customers`),
          api.get(`/auth/users/${user.id}/customers`),
          api.get('/customers/', { params: { limit: 1000 } }),
        ])
        const fallbackCustomerRows = Array.isArray(customerListRes.data) ? customerListRes.data : []
        const nextDirectAssignedMap = new Map<number, number | null>(
          fallbackCustomerRows.map((c: any) => [Number(c.id), c.assigned_to != null ? Number(c.assigned_to) : null])
        )
        const fallbackAssignedRows = fallbackCustomerRows
          .filter((c: any) => c.assigned_to != null && Number(c.assigned_to) === Number(user.id))
        const fallbackAssignedIds = fallbackAssignedRows.map((c: any) => Number(c.id))

        const mergedCustomers = new Map<number, any>()
        ;(availRes.data ?? []).forEach((c: any) => {
          mergedCustomers.set(Number(c.id), {
            ...c,
            assigned_to: nextDirectAssignedMap.get(Number(c.id)) ?? null,
          })
        })
        fallbackAssignedRows.forEach((c: any) => {
          if (!mergedCustomers.has(Number(c.id))) {
            mergedCustomers.set(Number(c.id), {
              id: Number(c.id),
              customer_name: c.customer_name,
              customer_vertical: c.customer_vertical,
              division: c.division,
              assigned_to: Number(c.assigned_to),
            })
          }
        })

        setAvailableCustomers([...mergedCustomers.values()])
        setDirectAssignedMap(nextDirectAssignedMap)
        setAssignedIds(new Set([
          ...(assignedRes.data as any[]).map((c: any) => Number(c.id)),
          ...fallbackAssignedIds,
        ]))
      } catch { showError('Failed to load customers') }
      finally { setLoading(false) }
    }
    init()
  }, [user.id])

  const toggle = (id: number) =>
    setAssignedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.put(`/auth/users/${user.id}/customers`, { customer_ids: [...assignedIds] })
      success(`Customers updated for ${user.full_name}`)
      onClose()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to save')
    } finally { setSaving(false) }
  }

  const visibleCustomers = availableCustomers.filter(c => {
    const directAssignedTo = directAssignedMap.get(Number(c.id))
    return directAssignedTo == null || Number(directAssignedTo) === Number(user.id)
  })

  const filtered   = visibleCustomers.filter(c =>
    !search ||
    c.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
    c.customer_vertical?.toLowerCase().includes(search.toLowerCase()) ||
    c.division?.toLowerCase().includes(search.toLowerCase())
  )
  const assigned   = filtered.filter(c =>  assignedIds.has(Number(c.id)))
  const unassigned = filtered.filter(c => !assignedIds.has(Number(c.id)))

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 py-3 bg-emerald-50 border-b border-emerald-100 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-emerald-600 flex items-center justify-center text-white text-sm font-bold">
          {user.full_name?.[0]?.toUpperCase()}
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">{user.full_name}</p>
          <p className="text-xs text-emerald-600">
            {assignedIds.size} customer(s) assigned · <RoleBadge role={user.role} label={getRoleLabel(user.role)} />
          </p>
        </div>
      </div>

      <div className="px-5 py-3 border-b border-gray-100">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search customers…"
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-300"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-gray-400">
          Only unassigned customers are listed. Customers already assigned to other users won't appear here.
        </p>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          Loading customers…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {assigned.length > 0 && (
            <div>
              <div className="px-5 py-2 bg-emerald-50 border-b border-emerald-100">
                <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">
                  Assigned ({assigned.length})
                </p>
              </div>
              {assigned.map(c => (
                <CustomerRow key={c.id} customer={c} checked onToggle={() => toggle(c.id)} />
              ))}
            </div>
          )}
          {unassigned.length > 0 && (
            <div>
              <div className="px-5 py-2 bg-gray-50 border-b border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Available ({unassigned.length})
                </p>
              </div>
              {unassigned.map(c => (
                <CustomerRow key={c.id} customer={c} checked={false} onToggle={() => toggle(c.id)} />
              ))}
            </div>
          )}
          {filtered.length === 0 && (
            <div className="p-8 text-center text-gray-400 text-sm">
              {search ? 'No customers match your search' : 'No customers available'}
            </div>
          )}
        </div>
      )}

      <div className="px-5 py-4 border-t border-gray-100 flex gap-3">
        <Button onClick={handleSave} loading={saving} className="flex-1">
          <Check size={14} className="mr-1.5 inline-block" /> Save Assignment ({assignedIds.size})
        </Button>
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function CustomerRow({ customer, checked, onToggle }: { customer: any; checked: boolean; onToggle: () => void }) {
  return (
    <div
      onClick={onToggle}
      className={`flex items-center gap-3 px-5 py-3 cursor-pointer transition-colors border-b border-gray-50
        ${checked ? 'bg-emerald-50 hover:bg-emerald-100' : 'hover:bg-gray-50'}`}
    >
      <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 transition-all
        ${checked ? 'bg-emerald-500 border-emerald-500' : 'border-2 border-gray-300 bg-white'}`}>
        {checked && <Check size={11} className="text-white" strokeWidth={3} />}
      </div>
      <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500 text-xs font-bold flex-shrink-0">
        {customer.customer_name?.[0]?.toUpperCase() ?? '?'}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{customer.customer_name}</p>
        {customer.customer_vertical && (
          <p className="text-xs text-gray-400 truncate">
            {customer.customer_vertical}{customer.division ? ` · ${customer.division}` : ''}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function UserListPage() {
  const { label: usersLabel, singular: userSingular } = useModuleName('users')
  const navigate = useNavigate()
  const [users, setUsers]             = useState<any[]>([])
  const [loading, setLoading]         = useState(true)
  const [customerPanelUser, setCustomerPanelUser] = useState<any>(null)
  const [resetPasswordUser, setResetPasswordUser] = useState<any>(null)
  const [resetPasswordSaving, setResetPasswordSaving] = useState(false)
  const [resetPasswordForm, setResetPasswordForm] = useState(emptyResetPasswordForm())
  const [resetPasswordErrors, setResetPasswordErrors] = useState<{ new_password?: string; confirm_password?: string }>({})
  const [selectedUsers, setSelectedUsers] = useState<any[]>([])
  const [loggingOutSelected, setLoggingOutSelected] = useState(false)
  const [loggingOutAllUsers, setLoggingOutAllUsers] = useState(false)
  const [tableResetKey, setTableResetKey] = useState(0)
  const { success, error: showError } = useToast()
  const authUser = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)

  const [regions,  setRegions]  = useState<{ value: number; label: string }[]>([])
  const [states,   setStates]   = useState<{ value: number; label: string; region_id?: number }[]>([])
  const [roleDefinitions, setRoleDefinitions] = useState<RoleDefinition[]>([])

  const roleLabelMap = useMemo(() => {
    const map = new Map<string, string>()
    roleDefinitions.forEach(role => {
      if (role.name) map.set(role.name, role.display_name || humanizeRoleName(role.name))
    })
    return map
  }, [roleDefinitions])

  const getRoleLabel = (role?: string | null) => {
    const roleName = String(role ?? '')
    if (!roleName) return ''
    return roleLabelMap.get(roleName) || ROLE_CONFIG[roleName]?.label || humanizeRoleName(roleName)
  }

  const roleOptions = useMemo(() => {
    const activeRoles = roleDefinitions.filter(role => role.is_active !== false)
    if (!activeRoles.length) return DEFAULT_ROLE_OPTIONS

    return activeRoles.map(role => ({
      value: role.name,
      label: role.display_name || humanizeRoleName(role.name),
      subtitle: role.description || `${Number(role.permission_count ?? 0)} permissions`,
    }))
  }, [roleDefinitions])

  const loadRoleDefinitions = async () => {
    try {
      const r = await api.get('/roles')
      setRoleDefinitions(normalizeRoleDefinitions(r.data))
    } catch {
      // Keep fallback role labels if the role service is unavailable.
    }
  }

  useEffect(() => {
    loadRoleDefinitions()
    api.get('/masters/regions')
      .then(r => setRegions((r.data as any[]).map(x => ({ value: x.id, label: x.name }))))
      .catch(() => {})
    api.get('/masters/states')
      .then(r => setStates((r.data as any[]).map(x => ({ value: x.id, label: x.name, region_id: x.region_id ?? null }))))
      .catch(() => {})
  }, [])

  const load = async () => {
    setLoading(true)
    try {
      const [usersRes, kamTargetsRes] = await Promise.all([
        api.get('/auth/users'),
        api.get('/kam/targets').catch(() => ({ data: [] })),
      ])

      const latestKamTargetMap = buildLatestKamTargetMap(
        Array.isArray(kamTargetsRes.data) ? kamTargetsRes.data : []
      )

      const mergedUsers = (Array.isArray(usersRes.data) ? usersRes.data : []).map((user: any) => {
        const latestKamTarget = latestKamTargetMap.get(Number(user.id))
        return latestKamTarget != null
          ? { ...user, target: latestKamTarget }
          : user
      })

      setUsers(mergedUsers)
    }
    catch { showError('Failed to load users') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const openCreate = () => {
    navigate('/users/new')
  }
  const openEdit = (u: any) => {
    navigate(`/users/${u.id}/edit`, { state: { user: u } })
  }

  const toggleActive = async (u: any) => {
    try { await api.put(`/auth/users/${u.id}`, { is_active: !u.is_active }); success(`User ${u.is_active ? 'deactivated' : 'activated'}`); load() }
    catch { showError('Failed to update user status') }
  }

  const openResetPasswordModal = (user: any) => {
    setResetPasswordUser(user)
    setResetPasswordForm(emptyResetPasswordForm())
    setResetPasswordErrors({})
  }

  const closeResetPasswordModal = () => {
    if (resetPasswordSaving) return
    setResetPasswordUser(null)
    setResetPasswordForm(emptyResetPasswordForm())
    setResetPasswordErrors({})
  }

  const setResetPasswordField = (key: 'new_password' | 'confirm_password', value: string) => {
    setResetPasswordForm((prev) => ({ ...prev, [key]: value }))
    setResetPasswordErrors((prev) => ({
      ...prev,
      [key]: undefined,
      ...(key === 'new_password' ? { confirm_password: undefined } : {}),
    }))
  }

  const submitResetPassword = async () => {
    if (!resetPasswordUser) return

    const nextErrors: { new_password?: string; confirm_password?: string } = {}
    if (!resetPasswordForm.new_password) nextErrors.new_password = 'Password is required'
    else if (resetPasswordForm.new_password.length < 8) nextErrors.new_password = 'Minimum 8 characters required'

    if (!resetPasswordForm.confirm_password) nextErrors.confirm_password = 'Confirm password is required'
    else if (resetPasswordForm.new_password !== resetPasswordForm.confirm_password) nextErrors.confirm_password = 'Passwords must match'

    setResetPasswordErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    setResetPasswordSaving(true)
    try {
      await api.post(`/auth/users/${resetPasswordUser.id}/reset-password`, {
        new_password: resetPasswordForm.new_password,
        confirm_password: resetPasswordForm.confirm_password,
      })
      success(`Password updated for ${resetPasswordUser.full_name}`)
      setResetPasswordUser(null)
      setResetPasswordForm(emptyResetPasswordForm())
      setResetPasswordErrors({})
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to reset password')
    } finally {
      setResetPasswordSaving(false)
    }
  }

  const handleLogoutSelectedUsers = async () => {
    const selectedIds = selectedUsers.map(user => user.id)
    if (selectedIds.length === 0) {
      showError('Select at least one user')
      return
    }
    const { isConfirmed, checked } = await confirmActionWithCheckbox({
      title: 'Logout Selected Users?',
      text: `This will log out ${selectedIds.length} selected user(s) from their other active devices. If your own account is selected, this device will stay signed in.`,
      checkboxLabel: 'Also require password reset on next login',
      checkboxHint: 'Selected users will be logged out now and must change their password before continuing.',
      confirmButtonText: 'Logout Selected Users',
    })
    if (!isConfirmed) {
      return
    }

    setLoggingOutSelected(true)
    try {
      const response = await authApi.logoutSelectedUsers(selectedIds, checked)
      success(response.data?.message || 'Selected users logged out successfully')
      const currentUserWasLoggedOut = !!authUser?.id && selectedIds.includes(authUser.id)
      const currentSessionKept = response.data?.current_session_kept !== false
      setSelectedUsers([])
      setTableResetKey(prev => prev + 1)
      if (currentUserWasLoggedOut && !currentSessionKept) {
        logout()
        return
      }
      await load()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to log out selected users')
    } finally {
      setLoggingOutSelected(false)
    }
  }

  const handleLogoutAllUsers = async () => {
    const { isConfirmed, checked } = await confirmActionWithCheckbox({
      title: 'Logout All Users?',
      text: 'This will log out every user in this tenant from their active devices. The device you are using now will stay signed in.',
      checkboxLabel: 'Also require password reset on next login',
      checkboxHint: 'Every tenant user will be logged out now. If enabled, everyone must reset their password before continuing.',
      confirmButtonText: 'Logout All Users',
    })
    if (!isConfirmed) {
      return
    }

    setLoggingOutAllUsers(true)
    try {
      const response = await authApi.logoutAllUsers(checked)
      success(response.data?.message || 'All tenant users logged out successfully')
      setSelectedUsers([])
      setTableResetKey(prev => prev + 1)
      if (response.data?.current_session_kept === false) {
        logout()
        return
      }
      await load()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to log out all users')
    } finally {
      setLoggingOutAllUsers(false)
    }
  }

  const stats = {
    total:    users.length,
    active:   users.filter(u => u.is_active).length,
    managers: users.filter(u => ['manager', 'vp'].includes(u.role)).length,
    sales:    users.filter(u => u.role === 'sales').length,
  }

  const canBulkLogout     = ADMIN_ROLES.includes(authUser?.role ?? '')
  const canLogoutAllUsers = ['admin', 'ceo'].includes(authUser?.role ?? '')

  const tableUsers = useMemo(() => users.map(user => {
    const groupList = normalizeUserGroups(user)
    return {
      ...user,
      role_label: getRoleLabel(user.role),
      group_name: groupList.map(group => group.name).join(', '),
      group_list: groupList,
    }
  }), [users, roleLabelMap])

  const tableToolbar = canBulkLogout ? (
    <>
      <Button
        size="sm"
        variant="warning"
        loading={loggingOutSelected}
        disabled={selectedUsers.length === 0 || loggingOutSelected || loggingOutAllUsers}
        onClick={handleLogoutSelectedUsers}
        icon={<LogOut size={13} />}
      >
        Logout Selected Users
      </Button>
      {canLogoutAllUsers && (
        <Button
          size="sm"
          variant="danger"
          loading={loggingOutAllUsers}
          disabled={loggingOutSelected || loggingOutAllUsers}
          onClick={handleLogoutAllUsers}
          icon={<LogOut size={13} />}
        >
          Logout All Users
        </Button>
      )}
    </>
  ) : null

  const columns = [
    {
      key:      'full_name',
      header:   'User',
      sortable: true,
      searchKeys: ['username', 'employee_code'],
      width:    '220px',
      render:   (v: unknown, row: any) => (
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {(v as string)?.[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{v as string}</p>
            <p className="text-xs text-gray-400 truncate">
              @{row.username}
              {row.employee_code && <span className="ml-1.5 text-gray-300">· {row.employee_code}</span>}
            </p>
          </div>
        </div>
      ),
    },
    {
      key:      'email',
      header:   'Email',
      sortable: true,
      width:    '155px',
      render:   (v: unknown) => (
        <span className="text-sm text-gray-600 truncate block">{v as string}</span>
      ),
    },
    {
      key:    'role_label',
      header: 'Role',
      width:  '130px',
      render: (v: unknown, row: any) => <RoleBadge role={row.role} label={v as string} />,
    },
    {
      key:      'region_name',
      header:   'Region',
      sortable: true,
      width:    '100px',
      render:   (v: unknown) => v
        ? <span className="inline-flex items-center gap-1 text-xs text-sky-700"><MapPin size={10} />{v as string}</span>
        : <span className="text-xs text-gray-300">—</span>,
    },
    {
      key:      'group_name',
      header:   'Group',
      sortable: true,
      width:    '150px',
      render:   (_v: unknown, row: any) => {
        const groups = Array.isArray(row.group_list) ? row.group_list : normalizeUserGroups(row)

        if (!groups.length) {
          return <span className="text-xs text-gray-300">—</span>
        }

        return (
          <div className="flex max-w-[150px] flex-wrap gap-1">
            {groups.slice(0, 2).map((group: UserGroupDisplay, index: number) => (
              <span
                key={group.id ?? `${group.name}-${index}`}
                title={group.name}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-purple-100 bg-purple-50 px-2 py-0.5 text-[11px] font-semibold text-purple-700"
              >
                <Users2 size={10} className="flex-shrink-0" />
                <span className="max-w-[92px] truncate">{group.name}</span>
              </span>
            ))}
            {groups.length > 2 && (
              <span className="inline-flex items-center rounded-full border border-gray-100 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">
                +{groups.length - 2}
              </span>
            )}
          </div>
        )
      },
    },
    {
      key:    'target',
      header: 'Target',
      width:  '100px',
      render: (v: unknown) => v != null && v !== ''
        ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
            <Target size={11} />{formatCompactTarget(v)}
          </span>
        : <span className="text-xs text-gray-300">—</span>,
    },
    {
      key:      'department',
      header:   'Department',
      sortable: true,
      width:    '90px',
    },
    {
      key:      'designation',
      header:   'Designation',
      sortable: true,
      width:    '100px',
      render:   (v: unknown) => (
        <span className="block whitespace-normal break-words text-sm leading-5 text-gray-700">{String(v || '—')}</span>
      ),
    },
    {
      key:    'is_active',
      header: 'Status',
      width:  '90px',
      render: (v: unknown) => <StatusBadge status={(v as boolean) ? 'Active' : 'Inactive'} />,
    },
    {
      key:        'id',
      header:     'Actions',
      width:      '150px',
      minWidth:   '150px',
      searchable: false,
      pinned:     true,
      render:     (_: unknown, row: any) => (
        <div className="flex gap-1">
          <button onClick={e => { e.stopPropagation(); openEdit(row) }}
            className="p-1.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="Edit user">
            <Edit2 size={14} />
          </button>
          <button onClick={e => { e.stopPropagation(); toggleActive(row) }}
            className="p-1.5 rounded text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
            title={row.is_active ? 'Deactivate' : 'Activate'}>
            {row.is_active ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
          </button>
          <button onClick={e => { e.stopPropagation(); openResetPasswordModal(row) }}
            className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors" title="Reset password">
            <Key size={14} />
          </button>
          {CUSTOMER_ASSIGN_ROLES.includes(row.role) && (
            <button onClick={e => { e.stopPropagation(); setCustomerPanelUser(row) }}
              className="p-1.5 rounded text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
              title="Assign customers">
              <Building2 size={14} />
            </button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="p-6">
      <PageHeader
        title={`${usersLabel} Management`}
        subtitle={`Manage CRM ${usersLabel.toLowerCase()}, roles, regions, groups and reporting hierarchy`}
        breadcrumb={['Settings', usersLabel]}
        actions={<div className="flex items-center gap-2"><button onClick={() => { loadRoleDefinitions(); load() }} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button><Button onClick={openCreate}><Plus size={15} className="mr-1.5 inline-block" /> Add User</Button></div>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title={`Total ${usersLabel}`} value={stats.total}    icon={<Users size={20} />} color="blue"   />
        <StatCard title="Active"      value={stats.active}   icon={<Users size={20} />} color="green"  />
        <StatCard title="Managers"    value={stats.managers} icon={<Users size={20} />} color="purple" />
        <StatCard title="Sales Team"  value={stats.sales}    icon={<Users size={20} />} color="amber"  />
      </div>

      <DataTable
        key={tableResetKey}
        columns={columns}
        data={tableUsers}
        loading={loading}
        showSearch
        showExport
        showColumnToggle
        exportFilename="users"
        maxHeight="520px"
        emptyMessage="No users found"
        selectable={canBulkLogout}
        onSelectionChange={setSelectedUsers}
        toolbar={tableToolbar}
      />

      {/* ── Customer Assignment Panel ── */}
      <SlidePanel
        open={!!customerPanelUser}
        onClose={() => setCustomerPanelUser(null)}
        title="Assign Customers"
        subtitle={`Assign customers to ${customerPanelUser?.full_name ?? ''}`}
      >
        {customerPanelUser && (
          <CustomerAssignPanel
            user={customerPanelUser}
            onClose={() => setCustomerPanelUser(null)}
            getRoleLabel={getRoleLabel}
          />
        )}
      </SlidePanel>

      {/* ── Reset Password Modal ── */}
      <Modal
        open={!!resetPasswordUser}
        onClose={closeResetPasswordModal}
        title="Update Password"
        subtitle={resetPasswordUser ? `Set a new password for ${resetPasswordUser.full_name}` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="cancel" onClick={closeResetPasswordModal} disabled={resetPasswordSaving}>
              Cancel
            </Button>
            <Button onClick={submitResetPassword} loading={resetPasswordSaving}>
              Update Password
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5">
            <p className="text-xs text-blue-700">
              The user will need to use this new password on their next sign in.
            </p>
          </div>
          <Input
            label="New Password"
            required
            type="password"
            value={resetPasswordForm.new_password}
            onChange={(v: unknown) => setResetPasswordField('new_password', strVal(v))}
            error={resetPasswordErrors.new_password}
            hint="Min 8 chars - must include uppercase, number and special character"
            disabled={resetPasswordSaving}
          />
          <Input
            label="Confirm Password"
            required
            type="password"
            value={resetPasswordForm.confirm_password}
            onChange={(v: unknown) => setResetPasswordField('confirm_password', strVal(v))}
            error={resetPasswordErrors.confirm_password}
            disabled={resetPasswordSaving}
          />
        </div>
      </Modal>
    </div>
  )
}
