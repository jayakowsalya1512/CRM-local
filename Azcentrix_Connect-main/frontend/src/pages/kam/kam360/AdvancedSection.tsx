import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Activity,
  Briefcase,
  Building2,
  ChevronDown,
  ChevronUp,
  FileText,
  GitBranch,
  IndianRupee,
  MapPin,
  Navigation,
  Sparkles,
  TreePine,
  TrendingUp,
  Users,
} from 'lucide-react'
import { useAuthStore } from '@/store'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { fmt, isSalesKAMUser, RoleBadge } from './shared'
import { EmployeeVisitCoverageReport } from './advanced/visitCoverage/EmployeeVisitCoverageReport'
import { UserLocationDayMapReport } from './advanced/userLocation/UserLocationDayMapReport'

type Metric = {
  value: number
  count: number
}

type AdvancedKAM360TabProps = {
  teamMembers: any[]
  teamRows: any[]
  masterGroups?: any[]
  customerRows?: any[]
  period: string
  isYearly: boolean
  viewYear: number
  dateLabel?: string
  requestPeriod: string
  requestViewType: string
  dateFrom?: string
  dateTo?: string
  onLeadPanel: (uid?: number, name?: string, mode?: 'leads'|'opportunities') => void | Promise<void>
  onTenderPanel: (uid?: number, name?: string) => void | Promise<void>
  onCustomerPanel: (uid?: number, name?: string, ownOnly?: boolean) => void | Promise<void>
  onGroupCustomerPanel?: (groupName: string, members: any[]) => void | Promise<void>
  onGroupLeadPanel?: (groupName: string, members: any[], mode?: 'leads'|'opportunities') => void | Promise<void>
  onGroupTenderPanel?: (groupName: string, members: any[]) => void | Promise<void>
  onGroupWorkOrderPanel?: (groupName: string, members: any[]) => void | Promise<void>
  onActivityPanel: (actType: string, uid?: number, name?: string) => void
  selectedUid: number | null
  setSelectedUid: (v: number | null) => void
  onNavigate: (mod: string, params?: any) => void
  loading: boolean
  customerTotal?: number
  customerPotentialValue?: number
  onTableMonthChange?: (period: string) => void
  onTableYearChange?: (year: number) => void
}

const cleanText = (value: any) => String(value ?? '').trim()

const hasBackendMetric = (value: any) => value !== undefined && value !== null && value !== ''

const numberValue = (value: any, fallback = 0) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

const groupIdList = (row: any): number[] => {
  if (Array.isArray(row?.group_ids)) return row.group_ids.map((id: any) => Number(id)).filter(Boolean)
  return cleanText(row?.group_id).split(',').map((id: string) => Number(id.trim())).filter(Boolean)
}

const firstGroupName = (members: any[], groupId: any) => {
  const gid = Number(groupId || 0)
  for (const member of members || []) {
    const names = Array.isArray(member?.group_names)
      ? member.group_names.map((name: any) => cleanText(name)).filter(Boolean)
      : []
    if (names.length > 0) {
      const ids = groupIdList(member)
      const index = gid ? ids.findIndex(id => id === gid) : -1
      if (index >= 0 && names[index]) return names[index]
      if (!gid) return names[0]
    }
    const direct = cleanText(member?.group_name)
    if (direct) return direct
  }
  return ''
}

const resolveGroupName = (group: any, members: any[] = [], head: any = null, fallback = 'Group') => {
  const groupNames = Array.isArray(group?.group_names)
    ? group.group_names.map((name: any) => cleanText(name)).filter(Boolean)
    : []
  if (groupNames.length > 0) return groupNames[0]

  for (const key of ['group_name', 'master_group_name', 'group_label', 'display_name', 'label', 'title', 'name']) {
    const text = cleanText(group?.[key])
    const headName = cleanText(head?.user_name || head?.full_name || head?.name || head?.label)
    if (text && (!headName || text.toLowerCase() !== headName.toLowerCase())) return text
  }

  const fromMember = firstGroupName([...(group?.members || []), ...members], group?.id)
  return fromMember || cleanText(fallback)
}

const backendGroupMetric = (group: any, key: string) => {
  if (hasBackendMetric(group?.[key])) return numberValue(group[key])
  if (hasBackendMetric(group?.metrics?.[key])) return numberValue(group.metrics[key])
  return null
}

const memberCustomerValue = (member: any) => numberValue(member?.customer_potential_value ?? member?.potential)
const memberCustomerCount = (member: any) => numberValue(member?.own_customers ?? member?.customers)
const memberWorkOrderValue = (member: any) => numberValue(member?.wo_value ?? member?.won_tender_value)

const sumMetric = (
  members: any[],
  valueFn: (member: any) => number,
  countFn: (member: any) => number,
): Metric => members.reduce((sum, member) => ({
  value: sum.value + valueFn(member),
  count: sum.count + countFn(member),
}), { value: 0, count: 0 })

const memberLevel = (member: any) => numberValue(member?.level, 99)
const memberPosition = (member: any) => numberValue(member?.position)
const byName = (a: any, b: any) => cleanText(a?.user_name || a?.full_name || a?.name).localeCompare(cleanText(b?.user_name || b?.full_name || b?.name))
const byHierarchy = (a: any, b: any) => (memberLevel(a) - memberLevel(b)) || (memberPosition(a) - memberPosition(b)) || byName(a, b)

const isHeadRole = (role: any) => ['vp', 'manager', 'sales_head', 'saleshead'].includes(cleanText(role).toLowerCase().replace(/[-\s]+/g, '_'))

function ValueCount({ value, count, valueLabel }: { value: number; count: number; valueLabel?: any }) {
  return (
    <span className="inline-flex min-w-[68px] items-baseline justify-end gap-1.5 whitespace-nowrap tabular-nums">
      <span className="text-[13px] font-semibold leading-none text-gray-900">{valueLabel ?? (value > 0 ? fmt(value) : fmt(0))}</span>
      <span className="text-[11px] leading-none text-slate-300">|</span>
      <span className="min-w-[18px] text-left text-[11px] font-medium leading-none text-gray-500">{numberValue(count).toLocaleString('en-IN')}</span>
    </span>
  )
}

function SummaryMetric({ label, metric, accent, valueLabel, onClick }: {
  label: string
  metric: Metric
  accent: string
  valueLabel?: any
  onClick?: () => void
}) {
  const content = (
    <>
      <span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-gray-500">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
        {label}
      </span>
      <ValueCount value={metric.value} count={metric.count} valueLabel={valueLabel} />
    </>
  )
  return onClick ? (
    <button type="button" onClick={event => { event.stopPropagation(); onClick() }} className="block min-w-0 rounded-lg px-2 py-1.5 text-left [font-family:inherit] transition hover:bg-slate-50">
      {content}
    </button>
  ) : (
    <div className="min-w-0 px-2 py-1.5">{content}</div>
  )
}

function MemberMetric({ value, count, onClick }: {
  value: number
  count: number
  onClick?: () => void
}) {
  const content = <ValueCount value={value} count={count} />
  return onClick ? (
    <button type="button" onClick={event => { event.stopPropagation(); onClick() }} className="inline-flex w-full justify-end text-right hover:underline">
      {content}
    </button>
  ) : (
    <span className="inline-flex w-full justify-end text-right">{content}</span>
  )
}

function buildHierarchyGroups(teamRows: any[], masterGroups: any[] = []) {
  const salesRows = teamRows.filter(member => isSalesKAMUser(member?.role))
  if (salesRows.length === 0) return []

  const metricsById = new Map<number, any>()
  salesRows.forEach(member => {
    const id = Number(member?.user_id || member?.id || member?.value || 0)
    if (id) metricsById.set(id, member)
  })

  const uniqueMembers = (rows: any[]) => {
    const seen = new Set<number>()
    return rows.filter(member => {
      const id = Number(member?.user_id || member?.id || member?.value || 0)
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  const mergeMasterMember = (raw: any, group: any) => {
    const uid = Number(raw?.user_id || raw?.id || raw?.value || 0)
    if (!uid || !metricsById.has(uid)) return null
    const metric = metricsById.get(uid) || {}
    const groupName = resolveGroupName(group, [raw], raw, `Group ${group?.id || ''}`.trim())
    const rawGroupIds = Array.isArray(raw?.group_ids) ? raw.group_ids.map((id: any) => Number(id)).filter(Boolean) : groupIdList(raw)
    const metricGroupIds = Array.isArray(metric?.group_ids) ? metric.group_ids.map((id: any) => Number(id)).filter(Boolean) : groupIdList(metric)
    const groupIds = Array.from(new Set([...rawGroupIds, ...metricGroupIds, Number(group?.id || 0)].filter(Boolean)))
    const rawGroupNames = Array.isArray(raw?.group_names) ? raw.group_names.map((name: any) => cleanText(name)).filter(Boolean) : []
    const metricGroupNames = Array.isArray(metric?.group_names) ? metric.group_names.map((name: any) => cleanText(name)).filter(Boolean) : []
    const groupNames = Array.from(new Set([...rawGroupNames, ...metricGroupNames, groupName].filter(Boolean)))
    const parentUserId = raw?.parent_user_id ?? raw?.reporting_manager_id ?? metric?.parent_user_id ?? metric?.reporting_manager_id ?? null
    const userName = metric.user_name || metric.full_name || raw?.user_name || raw?.full_name || raw?.name || raw?.label || `User ${uid}`
    return {
      ...raw,
      ...metric,
      id: uid,
      user_id: uid,
      user_name: userName,
      full_name: metric.full_name || raw?.full_name || raw?.name || userName,
      role: metric.role || raw?.role || raw?.user_role || '',
      group_id: groupIds.join(','),
      group_ids: groupIds,
      group_name: groupNames.join(', '),
      group_names: groupNames,
      parent_user_id: parentUserId ? Number(parentUserId) : null,
      reporting_manager_id: parentUserId ? Number(parentUserId) : null,
      level: numberValue(raw?.level ?? metric?.level),
      position: numberValue(raw?.position ?? metric?.position),
      is_group_lead: Boolean(raw?.is_group_lead || metric?.is_group_lead || uid === Number(group?.manager_id || group?.group_lead_id || 0)),
    }
  }

  if (masterGroups.length > 0) {
    const result: any[] = []
    masterGroups.forEach((group, index) => {
      const groupId = Number(group?.id || 0)
      const rawMembers = Array.isArray(group?.members) ? group.members : []
      const members = uniqueMembers(
        rawMembers.length > 0
          ? rawMembers.map((member: any) => mergeMasterMember(member, group)).filter(Boolean)
          : salesRows.filter(member => groupIdList(member).includes(groupId) || Number(group?.manager_id) === Number(member?.user_id)),
      ).filter(member => isSalesKAMUser(member?.role)).sort(rawMembers.length > 0 ? byHierarchy : byName)
      if (members.length === 0) return

      const manager = group?.manager_id
        ? members.find(member => Number(member?.user_id) === Number(group.manager_id))
        : null
      const head = manager || members.find(member => member?.is_group_lead || isHeadRole(member?.role)) || members[0]
      const name = resolveGroupName(group, members, head, `Group ${groupId || index + 1}`)
      result.push({
        ...group,
        id: groupId || index + 1,
        idx: index,
        name,
        group_name: name,
        manager: head,
        members,
      })
    })
    if (result.length > 0) return result
  }

  const grouped = new Map<string, any[]>()
  salesRows.forEach(member => {
    const ids = groupIdList(member)
    if (ids.length === 0) grouped.set('ungrouped', [...(grouped.get('ungrouped') || []), member])
    ids.forEach(id => grouped.set(String(id), [...(grouped.get(String(id)) || []), member]))
  })

  return Array.from(grouped.entries()).map(([key, rows], index) => {
    const members = uniqueMembers(rows).sort(byName)
    const head = members.find(member => isHeadRole(member?.role)) || members[0]
    const name = firstGroupName(members, key === 'ungrouped' ? null : key) || (key === 'ungrouped' ? 'Sales Team' : `Group ${key}`)
    return {
      id: key,
      idx: index,
      name,
      group_name: name,
      manager: head,
      members,
    }
  })
}

function TeamHierarchySummaryView({
  groups,
  selectedUid,
  onLeadPanel,
  onTenderPanel,
  onCustomerPanel,
  onGroupCustomerPanel,
  onGroupLeadPanel,
  onGroupTenderPanel,
  onGroupWorkOrderPanel,
}: {
  groups: any[]
  selectedUid: number | null
  onLeadPanel: (uid?: number, name?: string, mode?: 'leads'|'opportunities') => void | Promise<void>
  onTenderPanel: (uid?: number, name?: string) => void | Promise<void>
  onCustomerPanel: (uid?: number, name?: string, ownOnly?: boolean) => void | Promise<void>
  onGroupCustomerPanel?: (groupName: string, members: any[]) => void | Promise<void>
  onGroupLeadPanel?: (groupName: string, members: any[], mode?: 'leads'|'opportunities') => void | Promise<void>
  onGroupTenderPanel?: (groupName: string, members: any[]) => void | Promise<void>
  onGroupWorkOrderPanel?: (groupName: string, members: any[]) => void | Promise<void>
}) {
  const { label: customerLabel } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: opportunityLabel } = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: workOrderLabel } = useModuleName('workorders')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const palette = ['#0f9f8f', '#d08a2b', '#c64c7a', '#2d77bd', '#7c5ccf', '#1f9b67', '#be5b42']
  const visibleGroups = useMemo(() => {
    if (!selectedUid) return groups
    return groups
      .map(group => ({
        ...group,
        members: (group.members || []).filter((member: any) => Number(member?.user_id) === Number(selectedUid)),
      }))
      .filter(group => group.members.length > 0)
  }, [groups, selectedUid])

  useEffect(() => {
    setExpandedKeys(previous => {
      const keys = visibleGroups.map((group, index) => String(group?.id ?? group?.idx ?? group?.name ?? index))
      const next = new Set([...previous].filter(key => keys.includes(key)))
      if (next.size === 0 && keys[0]) next.add(keys[0])
      return next
    })
  }, [visibleGroups])

  const toggle = (key: string) => setExpandedKeys(previous => {
    const next = new Set(previous)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  if (visibleGroups.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white py-12 text-center">
        <Users size={24} className="mx-auto text-slate-300" />
        <p className="mt-2 text-sm font-semibold text-slate-400">No team data available</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 [font-family:var(--font-family)]">
      {visibleGroups.map((group, index) => {
        const members = [...(group.members || [])]
        const key = String(group?.id ?? group?.idx ?? group?.name ?? index)
        const expanded = expandedKeys.has(key)
        const accent = /^#[0-9a-f]{3,6}$/i.test(cleanText(group?.color)) ? group.color : palette[index % palette.length]
        const head = group?.manager && members.some(member => Number(member?.user_id) === Number(group.manager?.user_id))
          ? group.manager
          : members.find(member => member?.is_group_lead || isHeadRole(member?.role)) || members[0]
        const sortedMembers = [...members].sort((a, b) => {
          const aHead = Number(a?.user_id) === Number(head?.user_id) ? 0 : 1
          const bHead = Number(b?.user_id) === Number(head?.user_id) ? 0 : 1
          return aHead - bHead || byHierarchy(a, b)
        })
        const useGroupMetrics = !selectedUid
        const memberCustomers = sumMetric(members, memberCustomerValue, memberCustomerCount)
        const customers = {
          value: useGroupMetrics ? (backendGroupMetric(group, 'customer_potential_value') ?? memberCustomers.value) : memberCustomers.value,
          count: useGroupMetrics ? (backendGroupMetric(group, 'customer_count') ?? memberCustomers.count) : memberCustomers.count,
        }
        const memberLeads = sumMetric(members, member => numberValue(member?.lead_value), member => numberValue(member?.lead_count))
        const memberOpportunities = sumMetric(members, member => numberValue(member?.opportunity_value), member => numberValue(member?.opportunity_count))
        const memberTenders = sumMetric(members, member => numberValue(member?.tender_value), member => numberValue(member?.tender_count))
        const memberWorkOrders = sumMetric(members, memberWorkOrderValue, member => numberValue(member?.wo_count))
        const memberActivities = sumMetric(members, member => numberValue(member?.completed), member => numberValue(member?.total))
        const leads = {
          value: useGroupMetrics ? (backendGroupMetric(group, 'lead_value') ?? memberLeads.value) : memberLeads.value,
          count: useGroupMetrics ? (backendGroupMetric(group, 'lead_count') ?? memberLeads.count) : memberLeads.count,
        }
        const opportunities = {
          value: useGroupMetrics ? (backendGroupMetric(group, 'opportunity_value') ?? memberOpportunities.value) : memberOpportunities.value,
          count: useGroupMetrics ? (backendGroupMetric(group, 'opportunity_count') ?? memberOpportunities.count) : memberOpportunities.count,
        }
        const tenders = {
          value: useGroupMetrics ? (backendGroupMetric(group, 'tender_value') ?? memberTenders.value) : memberTenders.value,
          count: useGroupMetrics ? (backendGroupMetric(group, 'tender_count') ?? memberTenders.count) : memberTenders.count,
        }
        const workOrders = {
          value: useGroupMetrics ? (backendGroupMetric(group, 'wo_value') ?? memberWorkOrders.value) : memberWorkOrders.value,
          count: useGroupMetrics ? (backendGroupMetric(group, 'wo_count') ?? memberWorkOrders.count) : memberWorkOrders.count,
        }
        const activities = {
          value: useGroupMetrics ? (backendGroupMetric(group, 'completed_activity_count') ?? memberActivities.value) : memberActivities.value,
          count: useGroupMetrics ? (backendGroupMetric(group, 'activity_count') ?? memberActivities.count) : memberActivities.count,
        }
        const openGroupCustomers = () => onGroupCustomerPanel ? onGroupCustomerPanel(group.name, members) : head && onCustomerPanel(head.user_id, group.name, false)
        const openGroupLeads = (mode: 'leads'|'opportunities') => onGroupLeadPanel ? onGroupLeadPanel(group.name, members, mode) : head && onLeadPanel(head.user_id, group.name, mode)
        const openGroupTenders = () => onGroupTenderPanel ? onGroupTenderPanel(group.name, members) : head && onTenderPanel(head.user_id, group.name)
        const openGroupWorkOrders = () => onGroupWorkOrderPanel ? onGroupWorkOrderPanel(group.name, members) : undefined

        return (
          <div key={key} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_10px_28px_rgba(15,23,42,0.06)]" style={{ borderLeft: `4px solid ${accent}` }}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(key)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  toggle(key)
                }
              }}
              className="flex w-full cursor-pointer items-center gap-4 px-5 py-3.5 text-left [font-family:inherit]"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
              <span className="min-w-0 flex-[1_1_230px]">
                <span className="block truncate text-sm font-semibold text-gray-900">{group.name}</span>
                <span className="mt-0.5 block truncate text-[11px] font-medium text-gray-400">
                  Head: {head?.user_name || group.manager_name || group.name} - {members.length} member{members.length !== 1 ? 's' : ''}
                </span>
              </span>
              <span className="hidden min-w-0 flex-[4_1_860px] grid-cols-6 gap-2 lg:grid">
                <SummaryMetric label={customerLabel} metric={customers} accent="#536cab" onClick={head ? openGroupCustomers : undefined} />
                <SummaryMetric label={leadLabel} metric={leads} accent="#2f9a8b" onClick={head ? () => openGroupLeads('leads') : undefined} />
                <SummaryMetric label={opportunityLabel} metric={opportunities} accent="#c78b3f" onClick={head ? () => openGroupLeads('opportunities') : undefined} />
                <SummaryMetric label={tenderLabel} metric={tenders} accent="#8d63aa" onClick={head ? openGroupTenders : undefined} />
                <SummaryMetric label={workOrderLabel} metric={workOrders} accent="#bf6d82" onClick={head && onGroupWorkOrderPanel ? openGroupWorkOrders : undefined} />
                <SummaryMetric label="Activity" metric={activities} accent="#2563eb" valueLabel={activities.value} />
              </span>
              <span className="shrink-0 text-slate-400">{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
            </div>

            <div className="grid grid-cols-2 gap-2 px-5 pb-3 sm:grid-cols-3 lg:hidden">
              <SummaryMetric label={customerLabel} metric={customers} accent="#536cab" onClick={head ? openGroupCustomers : undefined} />
              <SummaryMetric label={leadLabel} metric={leads} accent="#2f9a8b" onClick={head ? () => openGroupLeads('leads') : undefined} />
              <SummaryMetric label={opportunityLabel} metric={opportunities} accent="#c78b3f" onClick={head ? () => openGroupLeads('opportunities') : undefined} />
              <SummaryMetric label={tenderLabel} metric={tenders} accent="#8d63aa" onClick={head ? openGroupTenders : undefined} />
              <SummaryMetric label={workOrderLabel} metric={workOrders} accent="#bf6d82" onClick={head && onGroupWorkOrderPanel ? openGroupWorkOrders : undefined} />
              <SummaryMetric label="Activity" metric={activities} accent="#2563eb" valueLabel={activities.value} />
            </div>

            {expanded && (
              <div className="overflow-x-auto border-t border-slate-100 px-5 pb-2">
                <table className="w-full min-w-[1120px] table-fixed border-collapse text-left text-xs">
                  <colgroup>
                    <col style={{ width: '280px' }} />
                    <col style={{ width: '150px' }} />
                    <col style={{ width: '150px' }} />
                    <col style={{ width: '170px' }} />
                    <col style={{ width: '150px' }} />
                    <col style={{ width: '160px' }} />
                    <col style={{ width: '140px' }} />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 font-semibold text-gray-500">
                      <th className="w-[260px] py-2.5 pr-4">Member</th>
                      <th className="px-3 py-2.5 text-right">{customerLabel}</th>
                      <th className="px-3 py-2.5 text-right">{leadLabel}</th>
                      <th className="px-3 py-2.5 text-right">{opportunityLabel}</th>
                      <th className="px-3 py-2.5 text-right">{tenderLabel}</th>
                      <th className="px-3 py-2.5 text-right">{workOrderLabel}</th>
                      <th className="px-3 py-2.5 text-right">Activity</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {sortedMembers.map(member => (
                      <tr key={member.user_id} className="odd:bg-white even:bg-slate-50/45 transition hover:bg-blue-50/40">
                        <td className="py-2.5 pr-4">
                          <div className="min-w-0">
                            <span className="block truncate text-sm font-medium text-gray-800">{member.user_name}</span>
                            <span className="mt-0.5 flex items-center gap-1.5">
                              <RoleBadge role={member.role || 'sales'} />
                              {member.is_self && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[9px] font-black text-blue-700">YOU</span>}
                              {Number(member.user_id) === Number(head?.user_id) && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[9px] font-black text-indigo-700">HEAD</span>}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <MemberMetric value={memberCustomerValue(member)} count={memberCustomerCount(member)} onClick={() => onCustomerPanel(member.user_id, member.user_name, true)} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <MemberMetric value={numberValue(member.lead_value)} count={numberValue(member.lead_count)} onClick={() => onLeadPanel(member.user_id, member.user_name, 'leads')} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <MemberMetric value={numberValue(member.opportunity_value)} count={numberValue(member.opportunity_count)} onClick={() => onLeadPanel(member.user_id, member.user_name, 'opportunities')} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <MemberMetric value={numberValue(member.tender_value)} count={numberValue(member.tender_count)} onClick={() => onTenderPanel(member.user_id, member.user_name)} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <MemberMetric value={memberWorkOrderValue(member)} count={numberValue(member.wo_count)} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <ValueCount value={numberValue(member.completed)} count={numberValue(member.total)} valueLabel={numberValue(member.completed)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const TREE_GROUP_WIDTH = 178
const TREE_MEMBER_WIDTH = 150
const TREE_GAP = 24
const TREE_ACCENT = '#1d4ed8'

function treeRoleLabel(role: any) {
  const value = cleanText(role).toLowerCase()
  if (value === 'vp') return 'VP'
  if (['manager', 'sales_head', 'saleshead'].includes(value)) return 'Sales Head'
  if (value === 'sales') return 'Sales'
  if (value === 'admin') return 'Admin'
  if (value === 'ceo') return 'CEO'
  return cleanText(role) || 'Sales'
}

function CompactTreeMetric({ icon, value, tone = 'text-blue-600' }: { icon: ReactNode; value: string | number; tone?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 text-[8px] font-semibold leading-none ${tone}`}>
      <span className="shrink-0">{icon}</span>
      <span className="text-slate-700">{value}</span>
    </span>
  )
}

function CompactTreeCard({
  title,
  subtitle,
  accent,
  active = false,
  width = TREE_GROUP_WIDTH,
  children,
}: {
  title: string
  subtitle?: string
  accent: string
  active?: boolean
  width?: number
  children?: ReactNode
}) {
  return (
    <div
      className={`rounded-md border bg-white px-3 py-1.5 text-center shadow-[0_4px_12px_rgba(15,23,42,0.08)] ${active ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200'}`}
      style={{ borderLeft: `4px solid ${accent}`, width }}
    >
      <p className="truncate text-center text-[11px] font-semibold leading-snug text-slate-950">{title}</p>
      {subtitle && <p className="mt-0.5 truncate text-center text-[9px] font-medium leading-snug text-slate-500">{subtitle}</p>}
      {children && <div className="mt-1 border-t border-slate-100 pt-1">{children}</div>}
    </div>
  )
}

function GroupTreeAdvancedView({ groups, rootCustomers, selectedUid, onCustomerPanel, onGroupCustomerPanel }: {
  groups: any[]
  rootCustomers?: Metric
  selectedUid: number | null
  onCustomerPanel: (uid?: number, name?: string, ownOnly?: boolean) => void | Promise<void>
  onGroupCustomerPanel?: (groupName: string, members: any[]) => void | Promise<void>
}) {
  const { user: authUser } = useAuthStore()
  const auth = authUser as any
  const rootName = cleanText(auth?.full_name || auth?.name || auth?.username) || 'Admin'
  const rootRole = cleanText(auth?.role) || 'Admin'

  const visibleGroups = useMemo(() => {
    return (groups || [])
      .map((group, index) => {
        const members = [...(group.members || [])]
          .filter(member => !selectedUid || Number(member?.user_id) === Number(selectedUid))
          .sort((a, b) => {
            const aHead = Number(a?.user_id) === Number(group?.manager?.user_id) ? 0 : 1
            const bHead = Number(b?.user_id) === Number(group?.manager?.user_id) ? 0 : 1
            return aHead - bHead || byHierarchy(a, b)
          })
        if (members.length === 0) return null
        const useGroupMetrics = !selectedUid
        const memberCustomers = sumMetric(members, memberCustomerValue, memberCustomerCount)
        const customers = {
          value: useGroupMetrics ? (backendGroupMetric(group, 'customer_potential_value') ?? memberCustomers.value) : memberCustomers.value,
          count: useGroupMetrics ? (backendGroupMetric(group, 'customer_count') ?? memberCustomers.count) : memberCustomers.count,
        }
        const head = group?.manager && members.some(member => Number(member?.user_id) === Number(group.manager?.user_id))
          ? group.manager
          : members.find(member => member?.is_group_lead || isHeadRole(member?.role)) || members[0]
        const reportMembers = members.filter(member => Number(member?.user_id) !== Number(head?.user_id))
        const displayMembers = reportMembers.length > 0 ? reportMembers : members
        const backendMemberCount = selectedUid ? null : (backendGroupMetric(group, 'kam_member_count') ?? backendGroupMetric(group, 'member_count'))
        return {
          group,
          index,
          members,
          reportMembers,
          displayMembers,
          memberCount: backendMemberCount ?? members.length,
          head,
          customers,
          accent: TREE_ACCENT,
        }
      })
      .filter(Boolean) as Array<{
        group: any
        index: number
        members: any[]
        reportMembers: any[]
        displayMembers: any[]
        memberCount: number
        head: any
        customers: Metric
        accent: string
      }>
  }, [groups, selectedUid])

  const chartWidth = Math.max(980, visibleGroups.length * TREE_GROUP_WIDTH + Math.max(0, visibleGroups.length - 1) * TREE_GAP)
  const fallbackRootCustomers = useMemo(() => visibleGroups.reduce((sum, item) => ({
    value: sum.value + item.customers.value,
    count: sum.count + item.customers.count,
  }), { value: 0, count: 0 }), [visibleGroups])
  const rootMetric = rootCustomers && (numberValue(rootCustomers.value) > 0 || numberValue(rootCustomers.count) > 0)
    ? rootCustomers
    : fallbackRootCustomers

  if (visibleGroups.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white py-12 text-center text-sm text-slate-400 shadow-sm">
        No group tree data available
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm [font-family:var(--font-family)]">
      <div className="overflow-x-auto px-9 py-5">
        <div className="pb-1" style={{ width: chartWidth, minHeight: 640 }}>
          <div className="flex justify-center">
            <div className="rounded-md border border-blue-300 bg-white px-3 py-1.5 text-center shadow-[0_4px_14px_rgba(37,99,235,0.18)] ring-1 ring-blue-100" style={{ width: 160 }}>
              <p className="truncate text-center text-[11px] font-semibold leading-snug text-slate-950">{rootName}</p>
              <p className="mt-0.5 truncate text-center text-[9px] font-medium leading-snug text-slate-500 capitalize">{rootRole}</p>
              <div className="mt-1 flex items-center gap-3 border-t border-slate-100 pt-1">
                <CompactTreeMetric icon={<Building2 size={8} />} value={rootMetric.count} />
                <CompactTreeMetric icon={<IndianRupee size={8} />} value={fmt(rootMetric.value)} tone="text-emerald-600" />
              </div>
            </div>
          </div>

          <div className="mx-auto h-3 w-px bg-slate-300" />

          <div className="relative flex items-start pt-3" style={{ gap: TREE_GAP }}>
            {visibleGroups.length > 1 && <div className="absolute top-0 h-px bg-slate-300" style={{ left: TREE_GROUP_WIDTH / 2, right: TREE_GROUP_WIDTH / 2 }} />}
            {visibleGroups.map(({ group, members, displayMembers, memberCount, head, customers, accent }, index) => (
              <div key={String(group?.id ?? group?.idx ?? group?.name ?? index)} className="relative flex shrink-0 flex-col items-start" style={{ width: TREE_GROUP_WIDTH }}>
                <div className="absolute -top-3 h-3 w-px bg-slate-300" style={{ left: TREE_GROUP_WIDTH / 2 }} />
                <button
                  type="button"
                  className="text-center [font-family:inherit]"
                  onClick={() => onGroupCustomerPanel ? onGroupCustomerPanel(group.name, members) : members[0] && onCustomerPanel(members[0].user_id, group.name, false)}
                >
                  <CompactTreeCard
                    title={group.name}
                    subtitle={`Head: ${head?.user_name || group.manager_name || group.name}`}
                    accent={accent}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <CompactTreeMetric icon={<Building2 size={8} />} value={customers.count} />
                      <CompactTreeMetric icon={<IndianRupee size={8} />} value={fmt(customers.value)} tone="text-emerald-600" />
                      <CompactTreeMetric icon={<Users size={8} />} value={memberCount} tone="text-violet-600" />
                    </div>
                  </CompactTreeCard>
                </button>

                {displayMembers.length > 0 && (
                  <div className="relative mt-3 pl-[25px]" style={{ width: TREE_GROUP_WIDTH }}>
                    <div className="absolute bottom-[29px] left-[3px] top-[15px] w-px bg-slate-300" />
                    <div className="space-y-3">
                      {displayMembers.map(member => (
                        <div key={`${group?.id ?? group?.name}-${member.user_id}`} className="relative">
                          <div className="absolute left-[-22px] top-1/2 h-px w-[22px] -translate-y-1/2 bg-slate-300" />
                          <button
                            type="button"
                            className="text-center [font-family:inherit]"
                            onClick={() => onCustomerPanel(member.user_id, member.user_name, true)}
                          >
                            <CompactTreeCard
                              title={member.user_name}
                              subtitle={treeRoleLabel(member.role)}
                              accent={accent}
                              active={Number(member.user_id) === Number(head?.user_id)}
                              width={TREE_MEMBER_WIDTH}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <CompactTreeMetric icon={<Building2 size={8} />} value={memberCustomerCount(member)} />
                                <CompactTreeMetric icon={<IndianRupee size={8} />} value={fmt(memberCustomerValue(member))} tone="text-emerald-600" />
                              </div>
                            </CompactTreeCard>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function AdvancedKAM360Tab({
  teamRows,
  masterGroups = [],
  period,
  isYearly,
  viewYear,
  dateLabel,
  requestPeriod,
  requestViewType,
  dateFrom,
  dateTo,
  onLeadPanel,
  onTenderPanel,
  onCustomerPanel,
  onGroupCustomerPanel,
  onGroupLeadPanel,
  onGroupTenderPanel,
  onGroupWorkOrderPanel,
  selectedUid,
  loading,
  customerTotal = 0,
  customerPotentialValue = 0,
}: AdvancedKAM360TabProps) {
  const { label: customerLabel } = useModuleName('customers')
  const { label: leadLabel } = useModuleName('leads')
  const { label: opportunityLabel } = useModuleName('opportunities')
  const { label: tenderLabel } = useModuleName('tenders')
  const { label: workOrderLabel } = useModuleName('workorders')
  const [activeSection, setActiveSection] = useState<'tree'|'groupTree'|'visitCoverage'|'userLocation'>('tree')
  const groups = useMemo(() => buildHierarchyGroups(teamRows || [], masterGroups || []), [teamRows, masterGroups])
  const visibleRows = useMemo(() => {
    const rows = (teamRows || []).filter(member => isSalesKAMUser(member?.role))
    return selectedUid ? rows.filter(member => Number(member?.user_id) === Number(selectedUid)) : rows
  }, [teamRows, selectedUid])

  const totals = useMemo(() => {
    const customerMetric = {
      count: customerTotal || visibleRows.reduce((sum, member) => sum + memberCustomerCount(member), 0),
      value: customerPotentialValue || visibleRows.reduce((sum, member) => sum + memberCustomerValue(member), 0),
    }
    return {
      members: visibleRows.length,
      customers: customerMetric,
      activities: sumMetric(visibleRows, member => numberValue(member?.completed), member => numberValue(member?.total)),
      leads: sumMetric(visibleRows, member => numberValue(member?.lead_value), member => numberValue(member?.lead_count)),
      opportunities: sumMetric(visibleRows, member => numberValue(member?.opportunity_value), member => numberValue(member?.opportunity_count)),
      tenders: sumMetric(visibleRows, member => numberValue(member?.tender_value), member => numberValue(member?.tender_count)),
      revenue: sumMetric(visibleRows, memberWorkOrderValue, member => numberValue(member?.wo_count)),
    }
  }, [visibleRows, customerTotal, customerPotentialValue])

  if (loading) {
    return (
      <div className="py-16 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-violet-500 border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_8px_22px_rgba(15,23,42,0.05)]">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles size={14} className="text-blue-600" />
          <span className="text-xs font-black uppercase tracking-widest text-slate-900">Advanced Analytics</span>
          <span className="ml-1 text-xs font-semibold text-slate-400">{dateLabel || (isYearly ? `FY ${viewYear}` : period)}</span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <div>
            <div className="mb-1 flex items-center gap-1 text-sky-600"><Users size={13} /><span className="text-[9px] font-black uppercase tracking-wider">Members</span></div>
            <p className="text-xl font-black leading-none text-slate-950">{totals.members}</p>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-slate-600"><Building2 size={13} /><span className="text-[9px] font-black uppercase tracking-wider">{customerLabel}</span></div>
            <ValueCount value={totals.customers.value} count={totals.customers.count} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-violet-600"><TrendingUp size={13} /><span className="text-[9px] font-black uppercase tracking-wider">{leadLabel}</span></div>
            <ValueCount value={totals.leads.value} count={totals.leads.count} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-cyan-600"><Briefcase size={13} /><span className="text-[9px] font-black uppercase tracking-wider">{opportunityLabel}</span></div>
            <ValueCount value={totals.opportunities.value} count={totals.opportunities.count} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-orange-600"><FileText size={13} /><span className="text-[9px] font-black uppercase tracking-wider">{tenderLabel}</span></div>
            <ValueCount value={totals.tenders.value} count={totals.tenders.count} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-emerald-600"><GitBranch size={13} /><span className="text-[9px] font-black uppercase tracking-wider">{workOrderLabel}</span></div>
            <ValueCount value={totals.revenue.value} count={totals.revenue.count} />
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1 text-blue-600"><Activity size={13} /><span className="text-[9px] font-black uppercase tracking-wider">Activity</span></div>
            <ValueCount value={totals.activities.value} count={totals.activities.count} valueLabel={totals.activities.value} />
          </div>
        </div>
      </div>

      <div className="flex w-fit items-center gap-1 rounded-2xl bg-gray-100 p-1">
        {([
          { id: 'tree', label: 'Team Hierarchy', icon: <TreePine size={12} /> },
          { id: 'groupTree', label: 'Group Tree', icon: <GitBranch size={12} /> },
          { id: 'visitCoverage', label: 'Visit Coverage', icon: <MapPin size={12} /> },
          { id: 'userLocation', label: 'User Location', icon: <Navigation size={12} /> },
        ] as const).map(section => (
          <button
            key={section.id}
            type="button"
            onClick={() => setActiveSection(section.id)}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all ${activeSection === section.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            {section.icon}{section.label}
          </button>
        ))}
      </div>

      {activeSection === 'tree' && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-bold text-gray-800">
              <TreePine size={14} className="text-emerald-600" />Team Hierarchy
              <span className="text-xs font-normal text-gray-400">{groups.length} group{groups.length !== 1 ? 's' : ''}</span>
            </h3>
          </div>
          <TeamHierarchySummaryView
            groups={groups}
            selectedUid={selectedUid}
            onLeadPanel={onLeadPanel}
            onTenderPanel={onTenderPanel}
            onCustomerPanel={onCustomerPanel}
            onGroupCustomerPanel={onGroupCustomerPanel}
            onGroupLeadPanel={onGroupLeadPanel}
            onGroupTenderPanel={onGroupTenderPanel}
            onGroupWorkOrderPanel={onGroupWorkOrderPanel}
          />
        </div>
      )}

      {activeSection === 'groupTree' && (
        <GroupTreeAdvancedView
          groups={groups}
          rootCustomers={totals.customers}
          selectedUid={selectedUid}
          onCustomerPanel={onCustomerPanel}
          onGroupCustomerPanel={onGroupCustomerPanel}
        />
      )}

      {activeSection === 'visitCoverage' && (
        <EmployeeVisitCoverageReport
          requestPeriod={requestPeriod}
          requestViewType={requestViewType}
          viewYear={viewYear}
          dateFrom={dateFrom}
          dateTo={dateTo}
          dateLabel={dateLabel}
          selectedUid={selectedUid}
          teamRows={teamRows}
        />
      )}

      {activeSection === 'userLocation' && (
        <UserLocationDayMapReport
          selectedUid={selectedUid}
        />
      )}
    </div>
  )
}
