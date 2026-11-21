/**
 * RolesPage — Roles & Permissions Management
 */
import { Fragment, useState, useEffect, useCallback } from 'react'
import {
  ShieldCheck, Crown, TrendingUp, Calculator, Headphones, UserCog,
  Plus, Save, Trash2, X, Check, Minus, AlertCircle,
  Lock, Pencil, RotateCcw, CheckSquare, Square, Search,
  Sparkles, Info, RefreshCw,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import { useToast } from '@/components/ui/FormComponents'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { useAuthStore } from '@/store'
import { confirmAction } from '@/utils/sweetAlert'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Permission {
  id:          number
  key:         string
  module:      string
  action:      string
  description: string
}

interface PermissionGroup {
  module:      string
  label?:      string
  section?:    string
  sort_order?: number
  parent_key?: string | null
  permission_key?: string | null
  permissions: Permission[]
}

interface Role {
  id:               number
  name:             string
  display_name:     string
  level:            number
  description:      string | null
  is_system:        boolean
  is_active:        boolean
  color:            string | null
  icon:             string | null
  permission_count: number
  permissions:      Permission[]
  module_scopes?: Record<string, DataScope>
}

interface PresetRole {
  name:         string
  display_name: string
  level:        number
  description:  string
  color:        string
}

type DataScope = 'own' | 'team' | 'all' | 'none'

const DATA_SCOPE_OPTIONS = [
  { value: 'own', label: 'Own' },
  { value: 'team', label: 'Own + Team' },
  { value: 'all', label: 'All' },
  { value: 'none', label: 'None' },
]

const PRESET_ROLES: PresetRole[] = [
  { name: 'admin',       display_name: 'Admin',         level: 1, color: '#6366f1', description: 'Full system access — can manage everything' },
  { name: 'ceo',         display_name: 'CEO',           level: 2, color: '#0ea5e9', description: 'All operations — executive view' },
  { name: 'manager',     display_name: 'Sales Manager', level: 3, color: '#8b5cf6', description: 'Team management and reports' },
  { name: 'sales',       display_name: 'Sales Person',  level: 4, color: '#10b981', description: 'Own leads and customer management' },
  { name: 'accounts',    display_name: 'Accounts',      level: 5, color: '#f59e0b', description: 'Finance, invoicing and reports' },
  { name: 'support',     display_name: 'Support',       level: 6, color: '#ec4899', description: 'View only — customer support access' },
]

const ROLE_ICONS: Record<string, React.ReactNode> = {
  admin:       <ShieldCheck size={15} />,
  ceo:         <Crown       size={15} />,
  manager:     <UserCog     size={15} />,
  sales:       <TrendingUp  size={15} />,
  accounts:    <Calculator  size={15} />,
  support:     <Headphones  size={15} />,
}

const ROLE_COLORS: Record<string, string> = {
  admin:       '#6366f1',
  ceo:         '#0ea5e9',
  manager:     '#8b5cf6',
  sales:       '#10b981',
  accounts:    '#f59e0b',
  support:     '#ec4899',
}

// ── Removed: 'convert' — everyone has conversion rights (via reporting manager approval)
// ── Removed: 'contacts', 'platform' — not applicable here
const ACTION_ORDER  = ['view', 'create', 'update', 'delete', 'export', 'approve']
const ACTION_LABELS: Record<string, string> = {
  view:    'View',
  create:  'Create',
  update:  'Edit',
  delete:  'Delete',
  export:  'Export',
  approve: 'Approve',
}

const COLOR_PRESETS = [
  '#6366f1', '#0ea5e9', '#8b5cf6', '#10b981',
  '#f59e0b', '#ec4899', '#ef4444', '#14b8a6',
  '#f97316', '#84cc16', '#06b6d4', '#a78bfa',
]

const emptyRoleForm = () => ({
  name: '', display_name: '', level: 10, description: '', color: '#6366f1', icon: ''
})

function formatModuleLabel(moduleName: string, label?: string): string {
  if (label) return label
  return moduleName
    .split(/[_-]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatPermissionLabel(permission: Permission): string {
  if (permission.description) return permission.description
  return permission.key
    .split('.')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).replace(/_/g, ' '))
    .join(' ')
}

function formatDashboardAccessLabel(permission: Permission): string {
  return {
    customers: 'Customers',
    leads: 'Leads',
    tenders: 'Tenders',
    emdbg: 'EMD / BG',
    kam360: 'KAM 360',
    travel: 'Travel',
    login_tracker: 'Login Tracker',
  }[permission.action] || formatPermissionLabel(permission)
}

export default function RolesPage() {
  const { label: rolesLabel } = useModuleName('roles')
  const { user } = useAuthStore() as any
  const { success, error: showError } = useToast()
  const isAdmin = user?.role === 'admin' || user?.role === 'ceo'

  const [roles, setRoles]     = useState<Role[]>([])
  const [groups, setGroups]   = useState<PermissionGroup[]>([])
  const [loading, setLoading] = useState(true)

  const [selectedRole, setSelectedRole] = useState<Role | null>(null)
  const [dirtyPerms, setDirtyPerms]     = useState<Set<number>>(new Set())
  const [isDirty, setIsDirty]           = useState(false)
  const [saving, setSaving]             = useState(false)

  const [panelOpen, setPanelOpen]     = useState(false)
  const [editingRole, setEditingRole] = useState<Role | null>(null)
  const [roleForm, setRoleForm]       = useState(emptyRoleForm())
  const [formSaving, setFormSaving]   = useState(false)

  const [provisionOpen, setProvisionOpen]       = useState(false)
  const [provisioningRole, setProvisioningRole] = useState<PresetRole | null>(null)
  const [provisioning, setProvisioning]         = useState(false)
  const [dirtyModuleScopes, setDirtyModuleScopes] = useState<Record<string, DataScope>>({})

  const [search, setSearch] = useState('')

  // ── Load ──────────────────────────────────────────────────────────────────

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [rolesRes, permsRes] = await Promise.all([
        api.get('/roles'),
        api.get('/roles/all-permissions'),
      ])
      const rolesData: Role[] = rolesRes.data
      setRoles(rolesData)
      setGroups(permsRes.data)
      if (rolesData.length > 0 && !selectedRole) {
        selectRole(rolesData[0], rolesData[0].permissions)
      }
    } catch {
      showError('Failed to load roles')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [])

const selectRole = (role: Role, perms?: Permission[]) => {
  setSelectedRole(role)
  setDirtyPerms(new Set((perms ?? role.permissions).map(p => p.id)))
  setDirtyModuleScopes(role.module_scopes || {})
  setIsDirty(false)
}

  const handleSelectRole = async (role: Role) => {
    if (isDirty) {
      const confirmed = await confirmAction({
        title: 'Discard unsaved changes?',
        text: 'Your permission changes will be lost.',
        confirmButtonText: 'Discard changes',
        icon: 'warning',
      })
      if (!confirmed) return
    }
    try {
      const r = await api.get(`/roles/${role.id}`)
      selectRole(r.data)
    } catch {
      selectRole(role)
    }
  }

  const togglePerm = (permId: number) => {
    if (!isAdmin) return
    setDirtyPerms(prev => {
      const next = new Set(prev)
      next.has(permId) ? next.delete(permId) : next.add(permId)
      return next
    })
    setIsDirty(true)
  }

  const toggleModule = (modulePerms: Permission[]) => {
    if (!isAdmin) return
    const allIds = modulePerms.map(p => p.id)
    const allOn  = allIds.every(id => dirtyPerms.has(id))
    setDirtyPerms(prev => {
      const next = new Set(prev)
      allOn ? allIds.forEach(id => next.delete(id)) : allIds.forEach(id => next.add(id))
      return next
    })
    setIsDirty(true)
  }

  const setModuleScope = (module: string, scope: DataScope) => {
  setDirtyModuleScopes(prev => ({
    ...prev,
    [module]: scope,
  }))
  setIsDirty(true)
}

  const savePermissions = async () => {
    if (!selectedRole || !isDirty) return
    setSaving(true)
    try {
      await api.put(`/roles/${selectedRole.id}/permissions`, {
  permission_ids: Array.from(dirtyPerms),
  module_scopes: Object.entries(dirtyModuleScopes).map(([module, data_scope]) => ({
    module,
    data_scope,
  })),
})
      success('Permissions saved')
      setIsDirty(false)
      const r = await api.get('/roles')
      setRoles(r.data)
      const updated = r.data.find((ro: Role) => ro.id === selectedRole.id)
      if (updated) setSelectedRole(updated)
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const discardChanges = () => {
    if (selectedRole) {
      setDirtyPerms(new Set(selectedRole.permissions.map(p => p.id)))
      setDirtyModuleScopes(selectedRole.module_scopes || {})
      setIsDirty(false)
    }
  }

  const openCreate = () => { setEditingRole(null); setRoleForm(emptyRoleForm()); setPanelOpen(true) }
  const openEdit   = (role: Role) => {
    setEditingRole(role)
    setRoleForm({
      name: role.name, display_name: role.display_name, level: role.level,
      description: role.description || '', color: role.color || '#6366f1', icon: role.icon || ''
    })
    setPanelOpen(true)
  }

  const handleRoleSave = async () => {
    if (!roleForm.display_name.trim()) { showError('Display name required'); return }
    setFormSaving(true)
    try {
      if (editingRole) {
        await api.put(`/roles/${editingRole.id}`, roleForm); success('Role updated')
      } else {
        if (!roleForm.name.trim()) { showError('Role name required'); setFormSaving(false); return }
        await api.post('/roles', roleForm); success('Role created')
      }
      setPanelOpen(false); await loadAll()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to save role')
    } finally { setFormSaving(false) }
  }

  const handleDelete = async (role: Role) => {
    const confirmed = await confirmAction({
      title: 'Delete role?',
      text: `"${role.display_name}" will be permanently removed. This cannot be undone.`,
      confirmButtonText: 'Delete',
      icon: 'warning',
    })
    if (!confirmed) return
    try {
      await api.delete(`/roles/${role.id}`); success('Role deleted')
      if (selectedRole?.id === role.id) setSelectedRole(null)
      await loadAll()
    } catch (e: any) { showError(e.response?.data?.detail || 'Cannot delete role') }
  }

  const openProvision = (preset: PresetRole) => { setProvisioningRole(preset); setProvisionOpen(true) }

  const handleProvision = async () => {
    if (!provisioningRole) return
    setProvisioning(true)
    try {
      await api.post('/roles', {
        name: provisioningRole.name, display_name: provisioningRole.display_name,
        level: provisioningRole.level, description: provisioningRole.description,
        color: provisioningRole.color, icon: '',
      })
      success(`Role "${provisioningRole.display_name}" provisioned`)
      setProvisionOpen(false); setProvisioningRole(null); await loadAll()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Failed to provision role')
    } finally { setProvisioning(false) }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const sortedGroups = groups

  const allActions = ACTION_ORDER

  const existingRoleNames = new Set(roles.map(r => r.name))
  const missingPresets    = PRESET_ROLES.filter(p => !existingRoleNames.has(p.name))

  const filteredRoles = roles.filter(r =>
    r.display_name.toLowerCase().includes(search.toLowerCase()) ||
    r.name.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-500">Loading roles...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] text-gray-400 mb-0.5">Settings › {rolesLabel}</p>
            <h1 className="text-xl font-bold text-gray-900">{rolesLabel}</h1>
            <p className="text-sm text-gray-500 mt-0.5">Define what each role can see and do across the system</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadAll} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
            {isAdmin && (
              <Button onClick={openCreate} icon={<Plus size={15} />}>
                New Role
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* ── LEFT: Role list ──────────────────────────────────────────────── */}
        <div className="w-64 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col">

          {/* Search */}
          <div className="p-3 border-b border-gray-100">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-blue-400 bg-gray-50"
                placeholder="Search roles..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">

            {/* Existing roles */}
            {filteredRoles.length > 0 && (
              <div className="py-1">
                {filteredRoles.map(role => {
                  const isSelected = selectedRole?.id === role.id
                  const color = role.color || ROLE_COLORS[role.name] || '#6366f1'
                  return (
                    <button
                      key={role.id}
                      onClick={() => handleSelectRole(role)}
                      className={`w-full text-left px-3 py-3 flex items-start gap-3 border-b border-gray-50 transition-colors group
                        ${isSelected
                          ? 'bg-blue-50 border-l-[3px] border-l-blue-500'
                          : 'hover:bg-gray-50 border-l-[3px] border-l-transparent'
                        }`}
                    >
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ backgroundColor: color + '20', color }}
                      >
                        {ROLE_ICONS[role.name] || <ShieldCheck size={15} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-sm font-medium truncate ${isSelected ? 'text-blue-700' : 'text-gray-800'}`}>
                            {role.display_name}
                          </span>
                          {role.is_system && (
                            <span title="System role"><Lock size={10} className="text-gray-400 flex-shrink-0" /></span>
                          )}
                        </div>
                        <span className="text-[11px] text-gray-400">{role.permission_count} permissions</span>
                        {!role.is_active && (
                          <span className="ml-1.5 text-[10px] bg-red-100 text-red-600 px-1 rounded">Inactive</span>
                        )}
                      </div>
                      {isAdmin && (
                        <div className="flex gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={e => { e.stopPropagation(); openEdit(role) }}
                            className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50" title="Edit">
                            <Pencil size={11} />
                          </button>
                          {!role.is_system && (
                            <button onClick={e => { e.stopPropagation(); handleDelete(role) }}
                              className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50" title="Delete">
                              <Trash2 size={11} />
                            </button>
                          )}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            )}

            {/* Missing preset roles */}
            {isAdmin && missingPresets.length > 0 && !search && (
              <div className="border-t border-dashed border-gray-200 mt-1">
                <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400 flex items-center gap-1.5">
                  <Sparkles size={10} /> Not Yet Provisioned
                </p>
                {missingPresets.map(preset => (
                  <div key={preset.name} className="px-3 py-2.5 flex items-center gap-3 border-b border-gray-50">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 opacity-40"
                      style={{ backgroundColor: preset.color + '20', color: preset.color }}
                    >
                      {ROLE_ICONS[preset.name] || <ShieldCheck size={15} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-400">{preset.display_name}</p>
                      <p className="text-[11px] text-gray-300">Not created yet</p>
                    </div>
                    <button
                      onClick={() => openProvision(preset)}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors flex-shrink-0"
                    >
                      <Plus size={10} /> Add
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── CENTER: Permission Matrix ─────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 bg-gray-50 overflow-hidden">
          {selectedRole ? (
            <>
              {/* Matrix header */}
              <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{
                      backgroundColor: (selectedRole.color || ROLE_COLORS[selectedRole.name] || '#6366f1') + '20',
                      color: selectedRole.color || ROLE_COLORS[selectedRole.name] || '#6366f1',
                    }}
                  >
                    {ROLE_ICONS[selectedRole.name] || <ShieldCheck size={16} />}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-gray-900 text-sm">{selectedRole.display_name}</span>
                      {selectedRole.is_system && (
                        <span className="inline-flex items-center gap-1 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium">
                          <Lock size={9} /> System
                        </span>
                      )}
                      {isDirty && (
                        <span className="inline-flex items-center gap-1 text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">
                          Unsaved changes
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-400">
                      {Array.from(dirtyPerms).length} permissions selected
                      {selectedRole.description && ` · ${selectedRole.description}`}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isAdmin && isDirty && (
                    <>
                      <button onClick={discardChanges}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
                        <RotateCcw size={13} /> Discard
                      </button>
                      <button onClick={savePermissions} disabled={saving}
                        className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors font-medium">
                        {saving
                          ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</>
                          : <><Save size={13} /> Save Changes</>}
                      </button>
                    </>
                  )}
                  {isAdmin && !isDirty && (
                    <button onClick={() => openEdit(selectedRole)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                      <Pencil size={13} /> Edit Role
                    </button>
                  )}
                </div>
              </div>

              {/* Matrix table */}
              <div className="flex-1 overflow-auto p-5">
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ minWidth: 180 }}>
                          Module
                        </th>
                        <th className="px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center" style={{ minWidth: 130 }}>
  Data Visibility
</th>
                        {allActions.map(action => (
                          <th key={action} className="px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center" style={{ minWidth: 80 }}>
                            {ACTION_LABELS[action]}
                          </th>
                        ))}
                        {isAdmin && (
                          <th className="px-3 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center" style={{ width: 80 }}>
                            All
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedGroups.map((group, gi) => {
                        const modulePerms = group.permissions.filter(p => allActions.includes(p.action))
                        const KNOWN_DASHBOARD_ACTIONS = new Set(['customers', 'leads', 'tenders', 'emdbg', 'kam360', 'travel', 'login_tracker'])
                        const dashboardAccessPerms = group.module === 'dashboard'
                          ? group.permissions.filter(p => !allActions.includes(p.action) && KNOWN_DASHBOARD_ACTIONS.has(p.action))
                          : []
                        const otherPerms = group.permissions.filter(p =>
                          !allActions.includes(p.action) && !dashboardAccessPerms.includes(p)
                        )
                        const allTogglePerms = [...modulePerms, ...otherPerms]
                        const allOn  = allTogglePerms.length > 0 && allTogglePerms.every(p => dirtyPerms.has(p.id))
                        const someOn = allTogglePerms.some(p => dirtyPerms.has(p.id))
                        const dashboardAllOn = dashboardAccessPerms.length > 0
                          && dashboardAccessPerms.every(p => dirtyPerms.has(p.id))
                        const dashboardSomeOn = dashboardAccessPerms.some(p => dirtyPerms.has(p.id))

                        return (
                          <Fragment key={group.module}>
                          <tr className={`border-b border-gray-100 ${gi % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'} hover:bg-blue-50/20 transition-colors`}>
                            <td className="px-5 py-3">
                              <span className="font-medium text-gray-800 text-[13px]">
                                {formatModuleLabel(group.module, group.label)}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-center">
  <select
    disabled={!isAdmin}
    value={dirtyModuleScopes[group.module] || 'own'}
    onChange={e => setModuleScope(group.module, e.target.value as DataScope)}
    className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-700 focus:outline-none focus:border-blue-400 disabled:bg-gray-50 disabled:text-gray-400"
  >
    {DATA_SCOPE_OPTIONS.map(opt => (
      <option key={opt.value} value={opt.value}>{opt.label}</option>
    ))}
  </select>
</td>
                            {allActions.map(action => {
                              const perm = group.permissions.find(p => p.action === action)
                              if (!perm) {
                                return (
                                  <td key={action} className="px-3 py-3 text-center">
                                    <span className="text-gray-200 select-none">—</span>
                                  </td>
                                )
                              }
                              const isOn = dirtyPerms.has(perm.id)
                              return (
                                <td key={action} className="px-3 py-3 text-center">
                                  <button
                                    onClick={() => togglePerm(perm.id)}
                                    disabled={!isAdmin}
                                    title={perm.description || `${group.module}.${action}`}
                                    className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition-all duration-150
                                      ${isAdmin ? 'cursor-pointer' : 'cursor-default'}
                                      ${isOn
                                        ? 'bg-blue-500 text-white shadow-sm shadow-blue-200 hover:bg-blue-600'
                                        : isAdmin ? 'bg-gray-100 text-gray-300 hover:bg-gray-200' : 'bg-gray-100 text-gray-300'
                                      }`}
                                  >
                                    {isOn ? <Check size={13} strokeWidth={2.5} /> : <Minus size={13} />}
                                  </button>
                                </td>
                              )
                            })}
                            {isAdmin && (
                              <td className="px-3 py-3 text-center">
                                <button
                                  onClick={() => toggleModule(allTogglePerms)}
                                  title={allOn ? 'Remove all' : 'Select all'}
                                  className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition-all duration-150
                                    ${allOn
                                      ? 'bg-blue-100 text-blue-600 hover:bg-blue-200'
                                      : someOn ? 'bg-amber-100 text-amber-600 hover:bg-amber-200'
                                      : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                                >
                                  {allOn ? <CheckSquare size={13} /> : someOn ? <Minus size={13} /> : <Square size={13} />}
                                </button>
                              </td>
                            )}
                          </tr>
                          {dashboardAccessPerms.length > 0 && (
                            <tr className={`border-b border-gray-100 ${gi % 2 === 0 ? 'bg-white' : 'bg-gray-50/40'}`}>
                              <td className="px-5 py-3">
                                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                                  Dashboard Access
                                </span>
                              </td>
                              <td colSpan={allActions.length + 1} className="px-3 py-3">
                                <div className="flex flex-wrap justify-center gap-2">                                  {dashboardAccessPerms.map(perm => {
                                    const isOn = dirtyPerms.has(perm.id)
                                    return (
                                      <button
                                        key={perm.id}
                                        type="button"
                                        role="checkbox"
                                        aria-checked={isOn}
                                        disabled={!isAdmin}
                                        onClick={() => togglePerm(perm.id)}
                                        title={perm.key}
                                        className={`flex min-h-9 items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors
                                          ${isAdmin ? 'cursor-pointer' : 'cursor-default'}
                                          ${isOn
                                            ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                                            : isAdmin
                                              ? 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:bg-gray-50'
                                              : 'border-gray-200 bg-white text-gray-400'
                                          }`}
                                      >
                                        <span className={`flex h-4 w-4 items-center justify-center rounded border
                                          ${isOn ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-300 bg-white text-transparent'}`}>
                                          <Check size={11} strokeWidth={2.5} />
                                        </span>
                                        <span>{formatDashboardAccessLabel(perm)}</span>
                                      </button>
                                    )
                                  })}
                                </div>
                              </td>
                              {isAdmin && (
                                <td className="px-3 py-3 text-center">
                                  <button
                                    onClick={() => toggleModule(dashboardAccessPerms)}
                                    title={dashboardAllOn ? 'Remove all dashboard access' : 'Select all dashboard access'}
                                    className={`inline-flex items-center justify-center w-7 h-7 rounded-lg transition-all duration-150
                                      ${dashboardAllOn
                                        ? 'bg-blue-100 text-blue-600 hover:bg-blue-200'
                                        : dashboardSomeOn ? 'bg-amber-100 text-amber-600 hover:bg-amber-200'
                                        : 'bg-gray-100 text-gray-400 hover:bg-gray-200'}`}
                                  >
                                    {dashboardAllOn ? <CheckSquare size={13} /> : dashboardSomeOn ? <Minus size={13} /> : <Square size={13} />}
                                  </button>
                                </td>
                              )}
                            </tr>
                          )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Legend + note about conversion */}
                <div className="mt-3 flex items-center gap-5 px-1 flex-wrap">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <div className="w-5 h-5 rounded bg-blue-500 flex items-center justify-center">
                      <Check size={11} className="text-white" strokeWidth={2.5} />
                    </div>
                    Allowed
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <div className="w-5 h-5 rounded bg-gray-100 flex items-center justify-center">
                      <Minus size={11} className="text-gray-300" />
                    </div>
                    Not Allowed
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <span className="text-gray-300 text-base leading-none">—</span>
                    Not Applicable
                  </div>
                  {!isAdmin && (
                    <div className="flex items-center gap-1.5 text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded-lg border border-amber-200">
                      <Lock size={11} /> View only — Super Admin or CEO can edit permissions
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <ShieldCheck size={40} className="text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">Select a role to view permissions</p>
                {isAdmin && missingPresets.length > 0 && (
                  <p className="text-gray-400 text-xs mt-1">
                    {missingPresets.length} role(s) not yet provisioned — use the left panel to add them
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Role Editor Modal ──────────────────────────────────────────────── */}
      {panelOpen && (
        <div className="fixed inset-0 bg-black/40 z-[9998] flex items-center justify-center" onClick={() => setPanelOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-gray-100" style={{ zIndex: 9999 }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div>
                <h3 className="font-semibold text-gray-900">{editingRole ? 'Edit Role' : 'Create New Role'}</h3>
                <p className="text-xs text-gray-400 mt-0.5">{editingRole ? 'Update role metadata' : 'Custom roles can have any permissions assigned'}</p>
              </div>
              <button onClick={() => setPanelOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {editingRole?.is_system && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
                  <AlertCircle size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-amber-700">System role — display name and description only can be changed.</p>
                </div>
              )}
              {!editingRole && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Role Key <span className="text-red-500">*</span>
                    <span className="text-gray-400 font-normal ml-1">(lowercase, no spaces)</span>
                  </label>
                  <input
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                    placeholder="e.g. regional_manager"
                    value={roleForm.name}
                    onChange={e => setRoleForm(p => ({ ...p, name: e.target.value.toLowerCase().replace(/\s+/g, '_') }))}
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Display Name <span className="text-red-500">*</span></label>
                <input
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                  placeholder="e.g. Regional Manager"
                  value={roleForm.display_name}
                  onChange={e => setRoleForm(p => ({ ...p, display_name: e.target.value }))}
                />
              </div>
              {!editingRole?.is_system && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Level <span className="text-gray-400 font-normal ml-1">(lower = more senior)</span>
                  </label>
                  <input type="number" min={2} max={100}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
                    value={roleForm.level}
                    onChange={e => setRoleForm(p => ({ ...p, level: parseInt(e.target.value) || 10 }))}
                  />
                </div>
              )}
             
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                <textarea rows={2}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-200 resize-none"
                  placeholder="What is this role responsible for?"
                  value={roleForm.description}
                  onChange={e => setRoleForm(p => ({ ...p, description: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">Badge Color</label>
                <div className="flex items-center gap-2 flex-wrap">
                  {COLOR_PRESETS.map(c => (
                    <button key={c} onClick={() => setRoleForm(p => ({ ...p, color: c }))}
                      className={`w-7 h-7 rounded-lg transition-transform hover:scale-110 ${roleForm.color === c ? 'ring-2 ring-offset-1 ring-gray-400 scale-110' : ''}`}
                      style={{ backgroundColor: c }} />
                  ))}
                  <input type="color" className="w-7 h-7 rounded-lg border-0 cursor-pointer"
                    value={roleForm.color}
                    onChange={e => setRoleForm(p => ({ ...p, color: e.target.value }))}
                  />
                </div>
                <div className="mt-2">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                    style={{ backgroundColor: roleForm.color + '20', color: roleForm.color }}>
                    <ShieldCheck size={11} />{roleForm.display_name || 'Preview'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50">
              <button onClick={() => setPanelOpen(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors">
                Cancel
              </button>
              <button onClick={handleRoleSave} disabled={formSaving}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors font-medium">
                {formSaving
                  ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving...</>
                  : editingRole ? 'Update Role' : 'Create Role'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Provision Role Modal ───────────────────────────────────────────── */}
      {provisionOpen && provisioningRole && (
        <div className="fixed inset-0 bg-black/40 z-[9998] flex items-center justify-center" onClick={() => setProvisionOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden border border-gray-100" style={{ zIndex: 9999 }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-900">Provision Role</h3>
              <button onClick={() => setProvisionOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={16} /></button>
            </div>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 p-4 rounded-xl mb-4" style={{ backgroundColor: provisioningRole.color + '10' }}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                  style={{ backgroundColor: provisioningRole.color + '20', color: provisioningRole.color }}>
                  {ROLE_ICONS[provisioningRole.name] || <ShieldCheck size={18} />}
                </div>
                <div>
                  <p className="font-semibold text-gray-900">{provisioningRole.display_name}</p>
                  <p className="text-xs text-gray-500">{provisioningRole.description}</p>
                </div>
              </div>
              <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3">
                <Info size={14} className="text-blue-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-blue-700">
                  This will create <strong>{provisioningRole.display_name}</strong> with no permissions.
                  Assign permissions from the matrix after creation.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50">
              <button onClick={() => setProvisionOpen(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors">
                Cancel
              </button>
              <button onClick={handleProvision} disabled={provisioning}
                className="flex items-center gap-1.5 px-4 py-2 text-sm text-white rounded-lg hover:opacity-90 disabled:opacity-60 transition-colors font-medium"
                style={{ backgroundColor: provisioningRole.color }}>
                {provisioning
                  ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Creating...</>
                  : <><Sparkles size={13} /> Create {provisioningRole.display_name}</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
