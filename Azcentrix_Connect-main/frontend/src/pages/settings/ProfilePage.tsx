import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Building2,
  ChevronRight,
  Clock3,
  Hash,
  KeyRound,
  LogOut,
  Mail,
  Monitor,
  Phone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  User,
  Users,
} from 'lucide-react'
import api, { authApi } from '@/services/api'
import Button from '@/components/ui/Button'
import { PageHeader, useToast } from '@/components/ui/FormComponents'
import { StatusBadge } from '@/components/ui/DataTable'
import { useAuthStore } from '@/store'
import { formatRoleDisplayName, usePermissions } from '@/hooks'

type TreeNode = {
  id: number
  parent_id: number | null
  user_id: number | null
  level: number
  group_name?: string | null
  user_name: string
  user_role: string
  user_role_display: string
  children: TreeNode[]
}

type SubTreeNode = {
  name: string
  role: string
  level: number
  children: SubTreeNode[]
}

type GroupPosition = {
  groupId: number
  groupName: string
  level: number
  reportsTo: { name: string; role: string; level: number } | null
  subtree: SubTreeNode[]
}

const LEVEL_BADGE: Record<number, string> = {
  2: 'bg-amber-100 text-amber-800 border-amber-200',
  3: 'bg-blue-100 text-blue-800 border-blue-200',
  4: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  5: 'bg-violet-100 text-violet-800 border-violet-200',
  6: 'bg-rose-100 text-rose-800 border-rose-200',
}

function getLevelBadge(level: number) {
  return LEVEL_BADGE[level] || LEVEL_BADGE[((level - 1) % 5) + 2]
}

function buildSubtree(node: TreeNode): SubTreeNode {
  return {
    name: node.user_name,
    role: node.user_role_display || node.user_role,
    level: node.level,
    children: (node.children || []).filter((c) => c.user_id).map(buildSubtree),
  }
}

function findUserGroupPositions(tree: TreeNode[], userId: number): GroupPosition[] {
  const positions: GroupPosition[] = []

  function traverse(node: TreeNode, parent: TreeNode | null, groupRoot: TreeNode | null) {
    const currentGroup = node.group_name ? node : groupRoot
    if (node.user_id === userId && currentGroup) {
      positions.push({
        groupId: currentGroup.id,
        groupName: currentGroup.group_name || 'Group',
        level: node.level,
        reportsTo: parent && parent.user_id
          ? { name: parent.user_name, role: parent.user_role_display || parent.user_role, level: parent.level }
          : null,
        subtree: (node.children || []).filter((c) => c.user_id).map(buildSubtree),
      })
    }
    for (const child of node.children || []) {
      traverse(child, node.user_id ? node : parent, currentGroup)
    }
  }

  for (const root of tree) traverse(root, null, root)
  return positions
}

function HierarchyTree({ nodes, depth = 0 }: { nodes: SubTreeNode[]; depth?: number }) {
  if (!nodes.length) return null
  return (
    <div className={depth > 0 ? 'ml-4 border-l-2 border-gray-100 pl-3 space-y-2' : 'space-y-2'}>
      {nodes.map((node, i) => (
        <div key={i}>
          <div className="flex items-center gap-2 py-0.5">
            <span className={`inline-flex flex-shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${getLevelBadge(node.level)}`}>
              L{node.level}
            </span>
            <span className="text-sm font-medium text-gray-800 leading-tight">{node.name}</span>
            {node.role && <span className="text-xs text-gray-400 truncate">· {node.role}</span>}
          </div>
          {node.children.length > 0 && <HierarchyTree nodes={node.children} depth={depth + 1} />}
        </div>
      ))}
    </div>
  )
}

type LogoutHistoryEvent = {
  revoked_at: string
  revoked_by_user_id?: number | null
  revoked_by_name?: string | null
  revoke_scope?: string | null
  revoke_reason?: string | null
  session_count: number
  devices: string[]
  forced_by_other_user: boolean
}

type AccentTone = 'blue' | 'red' | 'green' | 'amber' | 'slate'

const ACCENT_STYLES: Record<AccentTone, { icon: string }> = {
  blue: { icon: 'bg-blue-100 text-blue-600' },
  red: { icon: 'bg-red-100 text-red-600' },
  green: { icon: 'bg-green-100 text-green-600' },
  amber: { icon: 'bg-amber-100 text-amber-600' },
  slate: { icon: 'bg-slate-100 text-slate-600' },
}

function formatDateTime(value?: string | null) {
  if (!value) return 'Unknown time'
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function formatLatestAlertParts(value?: string | null) {
  if (!value) return { date: 'No alerts', time: '' }
  const eventDate = new Date(value)
  return {
    date: eventDate.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }),
    time: eventDate
      .toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
      .replace('am', 'AM')
      .replace('pm', 'PM'),
  }
}

function formatTargetValue(value?: number | string | null) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 'Not assigned'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatLastLogin(value?: string | null) {
  if (!value) return 'Never logged in'
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function buildUserInitials(fullName?: string | null) {
  const parts = String(fullName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
  if (!parts.length) return 'U'
  return parts.map((part) => part.charAt(0).toUpperCase()).join('')
}

function getEventMeta(event: LogoutHistoryEvent) {
  if (event.forced_by_other_user) {
    const actorLabel = event.revoked_by_name || 'Administrator'
    return {
      title: 'Admin Force Logout',
      subtitle:
        event.revoke_scope === 'tenant'
          ? 'Your session was terminated by admin for security reasons.'
          : `Your session was terminated by ${actorLabel} for security reasons.`,
      badgeStatus: 'Warning',
      iconWrap: 'bg-red-50 text-red-600',
    }
  }

  if (event.revoke_scope === 'self') {
    return {
      title: 'Logout All Devices',
      subtitle: 'You signed out your other active sessions from this account.',
      badgeStatus: 'Active',
      iconWrap: 'bg-blue-50 text-blue-600',
    }
  }

  return {
    title: 'Session Revoked',
    subtitle: `Triggered by ${event.revoked_by_name || 'System'}`,
    badgeStatus: 'Active',
    iconWrap: 'bg-amber-50 text-amber-600',
  }
}

function ProfileMetricCard({
  title,
  value,
  icon,
  accent,
  valueClassName = '',
}: {
  title: string
  value: ReactNode
  icon: ReactNode
  accent: AccentTone
  valueClassName?: string
}) {
  const tone = ACCENT_STYLES[accent]

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-3.5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500">{title}</p>
          <div className={`mt-1.5 text-2xl font-bold text-gray-900 ${valueClassName}`}>{value}</div>
        </div>
        <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl ${tone.icon}`}>
          {icon}
        </div>
      </div>
    </div>
  )
}

function ProfileInfoTile({
  label,
  value,
  icon,
  accent = 'slate',
  className = '',
}: {
  label: string
  value: ReactNode
  icon: ReactNode
  accent?: AccentTone
  className?: string
}) {
  const tone = ACCENT_STYLES[accent]

  return (
    <div className={`rounded-xl border border-gray-100 bg-gray-50/60 p-3 ${className}`}>
      <div className="flex items-center gap-2.5">
        <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${tone.icon}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400">{label}</p>
          <div className="mt-0.5 text-sm font-medium leading-snug text-gray-800 break-words">{value}</div>
        </div>
      </div>
    </div>
  )
}

export default function ProfilePage() {
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const { roleDisplay } = usePermissions()
  const [events, setEvents] = useState<LogoutHistoryEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [groupPositions, setGroupPositions] = useState<GroupPosition[]>([])
  const [resetSending, setResetSending] = useState(false)
  const [resetSent, setResetSent] = useState(false)
  const { error: showError, success: showSuccess } = useToast()

  const loadProfile = async () => {
    try {
      const response = await authApi.me()
      if (response.data) setUser(response.data)
    } catch {
      showError('Failed to load profile details')
    }
  }

  const loadLogoutHistory = async (showLoader = true) => {
    if (showLoader) setLoading(true)
    else setRefreshing(true)

    try {
      const response = await authApi.getMyLogoutHistory(25)
      setEvents(Array.isArray(response.data) ? response.data : [])
    } catch {
      showError('Failed to load logout history')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  const handleResetPassword = async () => {
    setResetSending(true)
    try {
      await authApi.requestMyPasswordReset()
      setResetSent(true)
      showSuccess(`Reset link sent to ${user?.email}. All sessions will be logged out after reset.`)
    } catch {
      showError('Failed to send reset link. Please try again.')
    } finally {
      setResetSending(false)
    }
  }

  useEffect(() => {
    loadProfile()
    loadLogoutHistory()
    api.get('/masters/org-tree')
      .then((r) => {
        const tree = Array.isArray(r.data) ? (r.data as TreeNode[]) : []
        const uid = useAuthStore.getState().user?.id
        if (uid) setGroupPositions(findUserGroupPositions(tree, uid))
      })
      .catch(() => {})
  }, [])

  const stats = useMemo(() => {
    const forcedCount = events.filter((event) => event.forced_by_other_user).length
    const selfCount = events.filter((event) => event.revoke_scope === 'self').length
    return {
      total: events.length,
      forced: forcedCount,
      self: selfCount,
      latestParts: formatLatestAlertParts(events[0]?.revoked_at),
    }
  }, [events])

  const roleLabel = roleDisplay || formatRoleDisplayName(user?.role) || 'Not available'
  const userGroups = user?.groups || []
  const fallbackGroupNames = String(user?.group_name || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  const displayGroupNames = userGroups.length ? userGroups.map((group) => group.name) : fallbackGroupNames
  const userInitials = buildUserInitials(user?.full_name)
  const lastLoginLabel = formatLastLogin(user?.last_login)

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-6 pb-8">
      <PageHeader
        title="My Account"
        subtitle="View your profile details and recent logout alerts"
        breadcrumb={['Account', 'Profile']}
        actions={(
          <Button
            variant="secondary"
            size="sm"
            loading={refreshing}
            onClick={() => {
              loadProfile()
              loadLogoutHistory(false)
            }}
            icon={<RefreshCw size={14} />}
          >
            Refresh
          </Button>
        )}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <ProfileMetricCard
          title="Logout Alerts"
          value={stats.total}
          icon={<LogOut size={16} />}
          accent="blue"
        />
        <ProfileMetricCard
          title="Admin Forced"
          value={stats.forced}
          icon={<ShieldAlert size={16} />}
          accent="red"
        />
        <ProfileMetricCard
          title="Self Logout"
          value={stats.self}
          icon={<ShieldCheck size={16} />}
          accent="green"
        />
        <ProfileMetricCard
          title="Latest Alert"
          value={(
            <div className="flex flex-col leading-tight">
              <span>{stats.latestParts.date}</span>
              {stats.latestParts.time && <span className="mt-0.5 text-sm font-semibold">{stats.latestParts.time}</span>}
            </div>
          )}
          icon={<Clock3 size={16} />}
          accent="amber"
          valueClassName="text-lg sm:text-xl"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
            <div className="border-b border-gray-100 bg-gradient-to-br from-slate-50 via-white to-blue-50 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-2xl bg-slate-800 text-base font-bold text-white">
                  {userInitials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-bold text-gray-900">{user?.full_name || 'User'}</h2>
                    <StatusBadge status={user?.is_active ? 'Active' : 'Inactive'} />
                  </div>
                  <p className="text-xs text-gray-500">@{user?.username || 'unknown'}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                      {roleLabel}
                    </span>
                    {displayGroupNames.length > 0 && (
                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                        {displayGroupNames.length} Group{displayGroupNames.length === 1 ? '' : 's'}
                      </span>
                    )}
                    {user?.designation && (
                      <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                        {user.designation}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4">
              <div className="grid grid-cols-2 gap-2.5">
                <ProfileInfoTile
                  label="Email"
                  value={user?.email || 'Not available'}
                  icon={<Mail size={14} />}
                  accent="blue"
                  className="col-span-2"
                />
                <ProfileInfoTile label="Phone" value={user?.phone || 'Not provided'} icon={<Phone size={14} />} accent="green" />
                <ProfileInfoTile label="Username" value={`@${user?.username || 'unknown'}`} icon={<User size={14} />} accent="slate" />
                {user?.employee_code
                  ? <ProfileInfoTile label="Employee Code" value={user.employee_code} icon={<Hash size={14} />} accent="slate" />
                  : <ProfileInfoTile label="Last Login" value={lastLoginLabel} icon={<Clock3 size={14} />} accent="amber" />
                }
                {user?.employee_code && (
                  <ProfileInfoTile label="Last Login" value={lastLoginLabel} icon={<Clock3 size={14} />} accent="amber" />
                )}
                {user?.branch && <ProfileInfoTile label="Branch" value={user.branch} icon={<Building2 size={14} />} accent="slate" />}
                {Number(user?.target) > 0 && (
                  <ProfileInfoTile label="Annual Target" value={formatTargetValue(user?.target)} icon={<TrendingUp size={14} />} accent="green" />
                )}
              </div>

              <div className="mt-3 border-t border-gray-100 pt-3">
                {resetSent ? (
                  <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2.5 text-sm text-green-700">
                    <ShieldCheck size={15} className="flex-shrink-0" />
                    <span>Reset link sent to <strong>{user?.email}</strong>. Check your email and all sessions will be logged out after reset.</span>
                  </div>
                ) : (
                  <button
                    onClick={handleResetPassword}
                    disabled={resetSending}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    <KeyRound size={14} />
                    {resetSending ? 'Sending reset link…' : 'Reset Password'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-5 py-3.5">
              <h2 className="text-base font-bold text-gray-900">Recent Logout Alerts</h2>
              <p className="mt-0.5 text-xs text-gray-500">
                See when an admin or your own security action logged you out of other sessions.
              </p>
            </div>

          {loading ? (
            <div className="p-6 space-y-4">
              {[1, 2, 3].map((item) => (
                <div key={item} className="flex items-start gap-4 rounded-2xl border border-gray-100 p-4">
                  <div className="h-11 w-11 flex-shrink-0 animate-pulse rounded-2xl bg-gray-100" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-52 max-w-full animate-pulse rounded bg-gray-100" />
                    <div className="h-3 w-80 max-w-full animate-pulse rounded bg-gray-100" />
                    <div className="h-3 w-40 animate-pulse rounded bg-gray-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="p-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-green-50 text-green-600">
                <ShieldCheck size={24} />
              </div>
              <p className="mt-4 text-base font-semibold text-gray-800">No logout alerts yet</p>
              <p className="mt-1 text-sm text-gray-500">
                Forced or self logout events will appear here when they happen.
              </p>
            </div>
          ) : (
            <div className="space-y-4 p-6">
              {events.map((event, index) => {
                const meta = getEventMeta(event)
                return (
                  <div key={`${event.revoked_at}-${index}`} className="rounded-2xl border border-gray-100 p-4 transition-colors hover:bg-gray-50/60">
                    <div className="flex items-start gap-4">
                      <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl ${meta.iconWrap}`}>
                        <LogOut size={18} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-gray-900">{meta.title}</p>
                          <StatusBadge status={meta.badgeStatus} />
                        </div>
                        <p className="mt-1 text-sm text-gray-500">{meta.subtitle}</p>

                        <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
                          <span className="inline-flex items-center gap-1.5">
                            <Clock3 size={13} />
                            {formatDateTime(event.revoked_at)}
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <Monitor size={13} />
                            {event.session_count} session{event.session_count !== 1 ? 's' : ''}
                          </span>
                        </div>

                        {event.devices?.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {event.devices.map((device) => (
                              <span
                                key={device}
                                className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600"
                              >
                                {device}
                              </span>
                            ))}
                          </div>
                        )}

                        {event.revoke_reason && (
                          <p className="mt-3 text-xs text-gray-400">{event.revoke_reason}</p>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          </div>

          {groupPositions.length > 0 && (
            <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
              <div className="border-b border-gray-100 px-5 py-3.5">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-bold text-gray-900">Group Hierarchy</h2>
                  <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                    {groupPositions.length}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-gray-500">Your position and reporting chain within each group.</p>
              </div>
              <div className="divide-y divide-gray-50">
                {groupPositions.map((pos) => (
                  <div key={pos.groupId} className="p-4">
                    <div className="flex items-center justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <Users size={15} className="flex-shrink-0 text-slate-400" />
                        <span className="text-sm font-bold text-gray-900">{pos.groupName}</span>
                      </div>
                      <span className={`flex-shrink-0 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold ${getLevelBadge(pos.level)}`}>
                        L{pos.level} · {pos.reportsTo ? 'You' : 'Group Head'}
                      </span>
                    </div>

                    {pos.reportsTo && (
                      <div className="mb-3 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2">
                        <ChevronRight size={13} className="flex-shrink-0 text-gray-400" />
                        <span className="text-xs text-gray-500">Reports to</span>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${getLevelBadge(pos.reportsTo.level)}`}>
                          L{pos.reportsTo.level}
                        </span>
                        <span className="text-sm font-semibold text-gray-800">{pos.reportsTo.name}</span>
                        {pos.reportsTo.role && <span className="text-xs text-gray-400">· {pos.reportsTo.role}</span>}
                      </div>
                    )}

                    {pos.subtree.length > 0 && (
                      <div>
                        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                          Reporting to me ({pos.subtree.reduce((acc, n) => acc + 1 + n.children.length, 0)})
                        </p>
                        <HierarchyTree nodes={pos.subtree} />
                      </div>
                    )}

                    {!pos.reportsTo && pos.subtree.length === 0 && (
                      <p className="text-xs text-gray-400">No hierarchy configured for this group.</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
