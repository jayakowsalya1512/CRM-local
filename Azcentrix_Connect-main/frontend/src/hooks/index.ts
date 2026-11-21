import { useState, useCallback, useEffect } from 'react'
import { AxiosResponse } from 'axios'
import toast from 'react-hot-toast'

// ── Generic CRUD Hook ─────────────────────────────────────────────────────────
interface CrudOptions<T> {
  fetchFn: (params?: Record<string, unknown>) => Promise<AxiosResponse<T[]>>
  createFn?: (data: Record<string, unknown>) => Promise<AxiosResponse<T>>
  updateFn?: (id: number, data: Record<string, unknown>) => Promise<AxiosResponse<T>>
  deleteFn?: (id: number) => Promise<AxiosResponse>
  resourceName?: string
  autoFetch?: boolean
  initialParams?: Record<string, unknown>
}

export function useCrud<T extends { id: number }>({
  fetchFn,
  createFn,
  updateFn,
  deleteFn,
  resourceName = 'Record',
  autoFetch = true,
  initialParams = {},
}: CrudOptions<T>) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [params, setParams] = useState<Record<string, unknown>>(initialParams)

  const fetch = useCallback(async (overrideParams?: Record<string, unknown>) => {
    setLoading(true)
    setError(null)
    try {
      const p = overrideParams !== undefined ? overrideParams : params
      const res = await fetchFn(p)
      setData(Array.isArray(res.data) ? res.data : [])
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || `Failed to load ${resourceName}`
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [fetchFn, params, resourceName])

  const create = useCallback(async (payload: Record<string, unknown>): Promise<T | null> => {
    if (!createFn) return null
    setSaving(true)
    try {
      const res = await createFn(payload)
      setData((prev) => [res.data, ...prev])
      toast.success(`${resourceName} created successfully`)
      return res.data
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || `Failed to create ${resourceName}`
      toast.error(msg)
      return null
    } finally {
      setSaving(false)
    }
  }, [createFn, resourceName])

  const update = useCallback(async (id: number, payload: Record<string, unknown>): Promise<T | null> => {
    if (!updateFn) return null
    setSaving(true)
    try {
      const res = await updateFn(id, payload)
      setData((prev) => prev.map((item) => item.id === id ? res.data : item))
      toast.success(`${resourceName} updated successfully`)
      return res.data
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || `Failed to update ${resourceName}`
      toast.error(msg)
      return null
    } finally {
      setSaving(false)
    }
  }, [updateFn, resourceName])

  const remove = useCallback(async (id: number): Promise<boolean> => {
    if (!deleteFn) return false
    setDeleting(id)
    try {
      await deleteFn(id)
      setData((prev) => prev.filter((item) => item.id !== id))
      toast.success(`${resourceName} deleted`)
      return true
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || `Failed to delete ${resourceName}`
      toast.error(msg)
      return false
    } finally {
      setDeleting(null)
    }
  }, [deleteFn, resourceName])

  const updateFilters = useCallback((newParams: Record<string, unknown>) => {
    const merged = { ...params, ...newParams }
    setParams(merged)
    fetch(merged)
  }, [params, fetch])

  useEffect(() => {
    if (autoFetch) fetch()
  }, []) // eslint-disable-line

  return { data, loading, saving, deleting, error, fetch, create, update, remove, updateFilters, setData }
}

// ── Single Item Hook ──────────────────────────────────────────────────────────
export function useItem<T>(fetchFn: (id: number) => Promise<AxiosResponse<T>>, id?: number) {
  const [item, setItem] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)

  const fetch = useCallback(async (itemId: number) => {
    setLoading(true)
    try {
      const res = await fetchFn(itemId)
      setItem(res.data)
    } catch {
      toast.error('Failed to load item')
    } finally {
      setLoading(false)
    }
  }, [fetchFn])

  useEffect(() => {
    if (id) fetch(id)
  }, [id]) // eslint-disable-line

  return { item, loading, fetch, setItem }
}

// ── Form Hook ─────────────────────────────────────────────────────────────────
export function useForm<T extends Record<string, unknown>>(initialValues: T) {
  const [values, setValues] = useState<T>(initialValues)
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({})
  const [touched, setTouched] = useState<Partial<Record<keyof T, boolean>>>({})

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }))
  }, [errors])

  const setError = useCallback(<K extends keyof T>(key: K, msg: string) => {
    setErrors((prev) => ({ ...prev, [key]: msg }))
  }, [])

  const reset = useCallback(() => {
    setValues(initialValues)
    setErrors({})
    setTouched({})
  }, [initialValues])

  const handleChange = useCallback((
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => {
    const { name, value, type } = e.target
    const val = type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    setValue(name as keyof T, val as T[keyof T])
  }, [setValue])

  const touch = useCallback(<K extends keyof T>(key: K) => {
    setTouched((prev) => ({ ...prev, [key]: true }))
  }, [])

  const validate = useCallback((rules: Partial<Record<keyof T, (v: unknown) => string | undefined>>) => {
    const newErrors: Partial<Record<keyof T, string>> = {}
    for (const key in rules) {
      const msg = rules[key]?.(values[key])
      if (msg) newErrors[key] = msg
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [values])

  return { values, errors, touched, setValue, setError, setValues, reset, handleChange, touch, validate }
}

// ── Async Action Hook ─────────────────────────────────────────────────────────
export function useAsyncAction<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: { successMessage?: string; errorMessage?: string }
) {
  const [loading, setLoading] = useState(false)

  const execute = useCallback(async (...args: TArgs): Promise<TReturn | null> => {
    setLoading(true)
    try {
      const result = await fn(...args)
      if (options?.successMessage) toast.success(options.successMessage)
      return result
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        || options?.errorMessage
        || 'Action failed'
      toast.error(msg)
      return null
    } finally {
      setLoading(false)
    }
  }, [fn, options?.successMessage, options?.errorMessage])

  return { loading, execute }
}

// ── Debounce Hook ─────────────────────────────────────────────────────────────
export function useDebounce<T>(value: T, delay = 400): T {
  const [debouncedValue, setDebouncedValue] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debouncedValue
}

// ── Dashboard Preferences Hook ─────────────────────────────────────────────────
import { themeApi } from '@/services/api'
import { WidgetConfig } from '@/types'

const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'overview_stats',    visible: true, order: 0 },
  { id: 'lead_pipeline',     visible: true, order: 1 },
  { id: 'tender_stats',      visible: true, order: 2 },
  { id: 'monthly_trend',     visible: true, order: 3 },
  { id: 'recent_activities', visible: true, order: 4 },
  { id: 'approval_alerts',   visible: true, order: 5 },
  { id: 'upcoming_bids',     visible: true, order: 6 },
  { id: 'emdbg_expiry',      visible: true, order: 7 },
]

export function useDashboardPreferences() {
  const [widgets, setWidgets] = useState<WidgetConfig[]>(DEFAULT_WIDGETS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    themeApi.getDashboardPreferences()
      .then((res) => {
        if (res.data.widgets?.length) setWidgets(res.data.widgets)
      })
      .catch(() => {})
  }, [])

  const savePreferences = async (updated: WidgetConfig[]) => {
    setSaving(true)
    try {
      await themeApi.updateDashboardPreferences(updated)
      setWidgets(updated)
      toast.success('Dashboard layout saved')
    } catch {
      toast.error('Failed to save dashboard layout')
    } finally {
      setSaving(false)
    }
  }

  const toggleWidget = (id: string) => {
    const updated = widgets.map((w) => w.id === id ? { ...w, visible: !w.visible } : w)
    setWidgets(updated)
    savePreferences(updated)
  }

  const reorderWidgets = (newOrder: WidgetConfig[]) => {
    savePreferences(newOrder)
  }

  const sortedWidgets = [...widgets].sort((a, b) => a.order - b.order)

  return { widgets: sortedWidgets, toggleWidget, reorderWidgets, saving }
}

// ── Permissions Hook ──────────────────────────────────────────────────────────
// Re-export everything from usePermissions.ts so any file can import from
// the single barrel: import { usePermissions, clearPermissionCache } from '@/hooks'
export {
  usePermissions,
  loadPermissions,
  clearPermissionCache,
  formatRoleDisplayName,
} from './Usepermissions'

export type {
  UsePermissionsReturn,
} from './Usepermissions'
