import { useEffect, useState } from 'react'

import { authApi } from '@/services/api'
import { useAuthStore } from '@/store'

type WorkingGroupOption = {
  value: number
  label: string
  subtitle?: string
  reportingHierarchy?: WorkingGroupHierarchy[]
}

export type WorkingGroupHierarchy = {
  reporting_user_id?: number | null
  reporting_role: string
  level: number
  user_name?: string | null
}

export type WorkingGroup = {
  id: number
  name: string
  reporting_hierarchy?: WorkingGroupHierarchy[]
}

function formatWorkingGroupRole(role: string) {
  const normalized = String(role || '').toLowerCase()
  if (normalized === 'vp') return 'VP'
  if (normalized === 'ceo') return 'CEO'
  if (normalized === 'manager' || normalized === 'sales_head') return 'Flow Manager'
  return normalized
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function formatWorkingGroupFlow(hierarchy?: WorkingGroupHierarchy[]) {
  return (hierarchy || [])
    .slice()
    .sort((a, b) => (a.level || 0) - (b.level || 0))
    .map(item => {
      const role = formatWorkingGroupRole(item.reporting_role)
      const name = String(item.user_name || '').trim()
      return name ? `${role} (${name})` : role
    })
    .filter(Boolean)
    .join(' - ')
}

export function useWorkingGroups() {
  const user = useAuthStore((state) => state.user)
  const setUser = useAuthStore((state) => state.setUser)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!user?.id) return
    if (
      Array.isArray(user.groups)
      && user.groups.every(group => Array.isArray(group.reporting_hierarchy))
    ) return

    let active = true
    setLoading(true)
    authApi.me()
      .then((response) => {
        if (!active || !response.data) return
        setUser(response.data)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [setUser, user?.groups, user?.id])

  const groups: WorkingGroup[] = Array.isArray(user?.groups) ? user.groups : []
  const groupOptions: WorkingGroupOption[] = groups.map((group) => ({
    value: group.id,
    label: group.name,
    subtitle: formatWorkingGroupFlow(group.reporting_hierarchy),
    reportingHierarchy: group.reporting_hierarchy || [],
  }))
  // Admin/CEO auto-approve on the backend — they don't need a group assigned.
  const isTopLevelRole = ['admin', 'ceo'].includes((user?.role ?? '').toLowerCase())
  const hasAnyGroups = groupOptions.length > 0 || isTopLevelRole
  const hasMultipleGroups = groupOptions.length > 1
  const singleGroupId = groupOptions.length === 1 ? groupOptions[0].value : null
  const getGroupLabel = (groupId: number | null | undefined) =>
    groupOptions.find((group) => group.value === Number(groupId))?.label || ''

  return {
    loading,
    groups,
    groupOptions,
    hasAnyGroups,
    hasMultipleGroups,
    singleGroupId,
    getGroupLabel,
  }
}
