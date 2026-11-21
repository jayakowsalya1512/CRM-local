/**
 * usePermissions — Global permission hook
 * ========================================
 * Cache key is user ID — not role name — so switching between users
 * with the same role still fetches fresh permissions.
 */
import { useState, useEffect, useCallback } from 'react'
import api from '@/services/api'
import { useAuthStore } from '@/store'

interface PermCache {
  perms: Set<string>
  roleDisplay: string | null
  roleIcon: string | null
  roleColor: string | null
}

interface RoleMeta {
  name: string
  display_name?: string | null
  icon?: string | null
  color?: string | null
}

let _cache: PermCache | null = null
let _cacheKey: string | null = null
let _loading = false
let _lastBackgroundRefreshAt = 0
const _subs: Array<() => void> = []

function devLog(message: string) {
  if (import.meta.env.DEV) {
    console.debug(message)
  }
}

function _broadcast() {
  _subs.forEach(fn => fn())
}

function _getUserKey(): string | null {
  const state = useAuthStore.getState() as any
  const id = state?.user?.id
  return id != null ? String(id) : null
}

function _getUserRole(): string {
  const state = useAuthStore.getState() as any
  return String(state?.user?.role ?? '')
}

function _knownRoleDisplay(role: string): string | null {
  const known: Record<string, string> = {
    admin: 'Admin',
    ceo: 'CEO',
    project_lead: 'Project Lead',
    vp: 'Vice President',
    manager: 'Sales Head',
    sales: 'Sales Executive',
    accounts: 'Accounts',
    support: 'Support',
  }
  return known[role] ?? null
}

function _humanizeRole(role: string): string | null {
  if (!role) return null

  return role
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function formatRoleDisplayName(role?: string | null): string {
  const roleName = String(role ?? '')
  return _knownRoleDisplay(roleName) || _humanizeRole(roleName) || ''
}

function _findCurrentRole(data: unknown, roleName: string): RoleMeta | null {
  if (!Array.isArray(data) || !roleName) return null
  const found = data.find(role =>
    role && typeof role === 'object' && (role as RoleMeta).name === roleName,
  )
  return found ? found as RoleMeta : null
}

function _warmCacheFromAuthStore(): PermCache | null {
  const key = _getUserKey()
  if (_cache && key === _cacheKey) return _cache
  if (_cache && key !== _cacheKey) {
    _cache = null
    _cacheKey = null
  }

  const state = useAuthStore.getState() as any
  const permissions = Array.isArray(state?.permissions) ? state.permissions : []
  if (!key || !permissions.length) return null

  const userRole = _getUserRole()
  _cache = {
    perms: new Set<string>(permissions),
    roleDisplay: _knownRoleDisplay(userRole) || _humanizeRole(userRole),
    roleIcon: null,
    roleColor: null,
  }
  _cacheKey = key
  devLog('Using cached permissions')
  return _cache
}

export async function loadPermissions(force = false, fresh = false): Promise<PermCache> {
  const key = _getUserKey()

  if (key !== _cacheKey) {
    _cache = null
    _cacheKey = null
  }

  if (_cache && !force) return _cache

  if (_loading) {
    return new Promise(resolve => {
      const timer = setInterval(() => {
        if (!_loading) {
          clearInterval(timer)
          resolve(_cache ?? { perms: new Set(), roleDisplay: null, roleIcon: null, roleColor: null })
        }
      }, 40)
    })
  }

  _loading = true
  try {
    const [res, rolesRes] = await Promise.all([
      api.get('/roles/my-permissions', fresh ? { params: { fresh: 1 } } : undefined),
      api.get('/roles').catch(() => null),
    ])
    const userRole = _getUserRole()
    const currentRole = _findCurrentRole(rolesRes?.data, userRole)
    const nextPermissions = Array.isArray(res.data.permissions) ? res.data.permissions : []
    _cache = {
      perms: new Set<string>(nextPermissions),
      roleDisplay: currentRole?.display_name || res.data.role_display || _knownRoleDisplay(userRole) || _humanizeRole(userRole),
      roleIcon: currentRole?.icon || res.data.role_icon || null,
      roleColor: currentRole?.color || res.data.role_color || null,
    }
    _cacheKey = key
    useAuthStore.setState({ permissions: nextPermissions })
    _broadcast()
    return _cache
  } catch {
    const fallback = _cache ?? _warmCacheFromAuthStore()
    if (fallback) return fallback
    return { perms: new Set(), roleDisplay: null, roleIcon: null, roleColor: null }
  } finally {
    _loading = false
  }
}

export function clearPermissionCache(): void {
  _cache = null
  _cacheKey = null
  _loading = false
  _broadcast()
}

export interface UsePermissionsReturn {
  loaded: boolean
  can: (key: string) => boolean
  canAny: (keys: string[]) => boolean
  canAll: (keys: string[]) => boolean
  permissions: Set<string>
  roleDisplay: string | null
  roleIcon: string | null
  roleColor: string | null
  refresh: () => Promise<void>
}

export function usePermissions(): UsePermissionsReturn {
  const initialCache = _warmCacheFromAuthStore()
  const [data, setData] = useState<PermCache>(
    initialCache ?? { perms: new Set(), roleDisplay: null, roleIcon: null, roleColor: null },
  )
  const [loaded, setLoaded] = useState<boolean>(initialCache !== null)

  useEffect(() => {
    let refreshTimer: number | null = null
    const sync = () => {
      if (_cache) {
        setData({ ..._cache, perms: new Set(_cache.perms) })
        setLoaded(true)
      } else {
        setData({ perms: new Set(), roleDisplay: null, roleIcon: null, roleColor: null })
        setLoaded(false)
      }
    }
    _subs.push(sync)

    if (!_cache) {
      devLog('Refreshing permissions in background')
      loadPermissions().then(perms => {
        setData({ ...perms, perms: new Set(perms.perms) })
        setLoaded(true)
      })
    } else if (Date.now() - _lastBackgroundRefreshAt > 60_000) {
      _lastBackgroundRefreshAt = Date.now()
      refreshTimer = window.setTimeout(() => {
        devLog('Refreshing permissions in background')
        loadPermissions(true).then(perms => {
          setData({ ...perms, perms: new Set(perms.perms) })
          setLoaded(true)
        })
      }, 800)
    }

    return () => {
      const index = _subs.indexOf(sync)
      if (index !== -1) _subs.splice(index, 1)
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
    }
  }, [])

  const can = useCallback((key: string) => data.perms.has('*') || data.perms.has(key), [data.perms])
  const canAny = useCallback((keys: string[]) => data.perms.has('*') || keys.some(key => data.perms.has(key)), [data.perms])
  const canAll = useCallback((keys: string[]) => data.perms.has('*') || keys.every(key => data.perms.has(key)), [data.perms])

  const refresh = useCallback(async () => {
    const perms = await loadPermissions(true)
    setData({ ...perms, perms: new Set(perms.perms) })
    setLoaded(true)
  }, [])

  return {
    loaded,
    can,
    canAny,
    canAll,
    permissions: data.perms,
    roleDisplay: data.roleDisplay,
    roleIcon: data.roleIcon,
    roleColor: data.roleColor,
    refresh,
  }
}
