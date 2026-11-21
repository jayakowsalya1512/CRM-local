import { useState, useEffect, useCallback } from 'react'
import api from '@/services/api'

export interface FormFieldConfig {
  id: number
  module: string
  section: string
  field_key: string
  field_type: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea' | 'email' | 'url' | 'phone'
  label: string
  placeholder?: string
  options?: string[] | { value: string; label: string }[]
  col_span: 1 | 2
  is_required: boolean
  is_visible: boolean
  is_custom: boolean
  sort_order: number
}

// Cache to avoid re-fetching on every mount within the same session
const _cache: Record<string, FormFieldConfig[]> = {}
const FORM_CONFIG_CHANGED_EVENT = 'form-config:changed'

export function invalidateFormConfigCache(module?: string) {
  if (module) delete _cache[module]
  else Object.keys(_cache).forEach(key => delete _cache[key])

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FORM_CONFIG_CHANGED_EVENT, { detail: { module } }))
  }
}

export function useFormConfig(module: string) {
  const [fields, setFields] = useState<FormFieldConfig[]>(_cache[module] ?? [])
  const [loading, setLoading] = useState(!_cache[module])

  const fetchFields = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.get<FormFieldConfig[]>(`/form-config/${module}`)
      _cache[module] = res.data
      setFields(res.data)
    } catch {
      // non-fatal: custom fields simply won't render
    } finally {
      setLoading(false)
    }
  }, [module])

  useEffect(() => {
    if (!_cache[module]) {
      fetchFields()
    }
  }, [module]) // eslint-disable-line

  useEffect(() => {
    if (typeof window === 'undefined') return undefined

    const handleChange = (event: Event) => {
      const changedModule = (event as CustomEvent<{ module?: string }>).detail?.module
      if (!changedModule || changedModule === module) fetchFields()
    }

    window.addEventListener(FORM_CONFIG_CHANGED_EVENT, handleChange)
    return () => window.removeEventListener(FORM_CONFIG_CHANGED_EVENT, handleChange)
  }, [fetchFields, module])

  // Group by section — only custom fields (built-in overrides are handled by each form page directly)
  const bySection = fields.reduce<Record<string, FormFieldConfig[]>>((acc, f) => {
    if (!f.is_custom) return acc
    if (!acc[f.section]) acc[f.section] = []
    acc[f.section].push(f)
    return acc
  }, {})

  const invalidate = () => {
    delete _cache[module]
    fetchFields()
  }

  return { fields, bySection, loading, invalidate }
}

// Mutation helpers used by FormBuilderPage
export const formConfigApi = {
  create: (module: string, data: Omit<FormFieldConfig, 'id'>) =>
    api.post<FormFieldConfig>(`/form-config/${module}`, data).then(res => {
      invalidateFormConfigCache(module)
      return res
    }),

  update: (module: string, id: number, data: Partial<FormFieldConfig>) =>
    api.put<FormFieldConfig>(`/form-config/${module}/fields/${id}`, data).then(res => {
      invalidateFormConfigCache(module)
      return res
    }),

  reorder: (module: string, section: string, orders: { field_key: string; sort_order: number }[]) =>
    api.patch<FormFieldConfig[]>('/form-config/fields/reorder', { module, section, orders }).then(res => {
      invalidateFormConfigCache(module)
      return res
    }),

  delete: (module: string, id: number) =>
    api.delete(`/form-config/${module}/fields/${id}`).then(res => {
      invalidateFormConfigCache(module)
      return res
    }),
}
