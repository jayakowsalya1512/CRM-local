import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { useAuthStore } from '@/store'
import api from '@/services/api'

const LABELS_KEY_VERSION = 'v2'

function getStorageKey(tenantSlug: string | null): string | null {
  const slug = (tenantSlug || localStorage.getItem('tenant_slug') || '').trim()
  return slug ? `crm_module_labels:${LABELS_KEY_VERSION}:${slug}` : null
}

export interface ModuleNameEntry {
  label: string
  singular: string
}

interface ModuleLabelsContextValue {
  getLabel: (key: string, defaultLabel: string) => string
  getSingular: (key: string, defaultSingular: string) => string
  setLabel: (key: string, label: string) => void
  setModuleNames: (key: string, names: Partial<ModuleNameEntry>) => void
  resetLabel: (key: string) => void
  customLabels: Record<string, ModuleNameEntry>
}

const ModuleLabelsContext = createContext<ModuleLabelsContextValue>({
  getLabel: (_, d) => d,
  getSingular: (_, d) => d,
  setLabel: () => {},
  setModuleNames: () => {},
  resetLabel: () => {},
  customLabels: {},
})

export function ModuleLabelsProvider({ children }: { children: ReactNode }) {
  const tenantSlug = useAuthStore(state => state.tenant_slug)
  const [customLabels, setCustomLabels] = useState<Record<string, ModuleNameEntry>>({})

  useEffect(() => {
    const key = getStorageKey(tenantSlug)

    // 1. Optimistically load localStorage so labels appear instantly on paint
    if (key) {
      try {
        const stored = JSON.parse(localStorage.getItem(key) || '{}')
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
          const normalized: Record<string, ModuleNameEntry> = {}
          for (const [k, v] of Object.entries(stored)) {
            if (typeof v === 'string') {
              normalized[k] = { label: v, singular: '' }
            } else if (v && typeof v === 'object' && !Array.isArray(v)) {
              normalized[k] = { label: (v as any).label || '', singular: (v as any).singular || '' }
            }
          }
          setCustomLabels(normalized)
        }
      } catch {}
    }

    // 2. Fetch from the server — the single source of truth shared across all users
    api.get('/modules').then((r: any) => {
      const serverLabels: Record<string, ModuleNameEntry> = {}
      for (const mod of (r.data || []) as any[]) {
        if (mod.key) {
          serverLabels[mod.key] = {
            label:    mod.display_name          || '',
            singular: mod.display_name_singular || '',
          }
        }
      }
      setCustomLabels(serverLabels)
      if (key) {
        try { localStorage.setItem(key, JSON.stringify(serverLabels)) } catch {}
      }
    }).catch(() => {})
  }, [tenantSlug])

  const _persist = useCallback((next: Record<string, ModuleNameEntry>) => {
    const key = getStorageKey(tenantSlug)
    if (key) {
      try { localStorage.setItem(key, JSON.stringify(next)) } catch {}
    }
  }, [tenantSlug])

  // Updates only the plural label — used by sidebar inline rename
  const setLabel = useCallback((moduleKey: string, label: string) => {
    setCustomLabels(prev => {
      const existing = prev[moduleKey] || { label: '', singular: '' }
      const next = { ...prev, [moduleKey]: { ...existing, label } }
      _persist(next)
      return next
    })
    api.patch(`/modules/${moduleKey}/label`, { display_name: label }).catch(() => {})
  }, [_persist])

  // Updates both label and singular — used by Settings tab
  const setModuleNames = useCallback((moduleKey: string, names: Partial<ModuleNameEntry>) => {
    setCustomLabels(prev => {
      const existing = prev[moduleKey] || { label: '', singular: '' }
      const next = { ...prev, [moduleKey]: { ...existing, ...names } }
      _persist(next)
      return next
    })
    const payload: Record<string, string> = {}
    if (names.label !== undefined) payload.display_name = names.label
    if (names.singular !== undefined) payload.display_name_singular = names.singular
    if (Object.keys(payload).length) {
      api.patch(`/modules/${moduleKey}/label`, payload).catch(() => {})
    }
  }, [_persist])

  const resetLabel = useCallback((moduleKey: string) => {
    setCustomLabels(prev => {
      const next = { ...prev }
      delete next[moduleKey]
      _persist(next)
      return next
    })
    api.patch(`/modules/${moduleKey}/label`, { display_name: '', display_name_singular: '' }).catch(() => {})
  }, [_persist])

  const getLabel = useCallback((moduleKey: string, defaultLabel: string): string => {
    const custom = customLabels[moduleKey]
    return (custom?.label && custom.label.trim()) ? custom.label : defaultLabel
  }, [customLabels])

  const getSingular = useCallback((moduleKey: string, defaultSingular: string): string => {
    const custom = customLabels[moduleKey]
    return (custom?.singular && custom.singular.trim()) ? custom.singular : defaultSingular
  }, [customLabels])

  return (
    <ModuleLabelsContext.Provider value={{ getLabel, getSingular, setLabel, setModuleNames, resetLabel, customLabels }}>
      {children}
    </ModuleLabelsContext.Provider>
  )
}

export function useModuleLabels() {
  return useContext(ModuleLabelsContext)
}

// ─── Default names ────────────────────────────────────────────────────────────

export const DEFAULT_MODULE_NAMES: Record<string, ModuleNameEntry> = {
  dashboard:     { label: 'Dashboard',          singular: 'Dashboard' },
  customers:     { label: 'Customers',          singular: 'Customer' },
  questionnaire: { label: 'Questionnaire',      singular: 'Questionnaire' },
  leads:         { label: 'Leads',              singular: 'Lead' },
  opportunities: { label: 'Opportunities',      singular: 'Opportunity' },
  tenders:       { label: 'Tenders',            singular: 'Tender' },
  quotations:    { label: 'Quotations',         singular: 'Quotation' },
  workorders:    { label: 'Orders & Projects',  singular: 'Order' },
  emdbg:         { label: 'Guarantees & Deposits', singular: 'Instrument' },
  kam:           { label: 'Field Sales 360',    singular: 'KAM Activity' },
  travel:        { label: 'Travel & Expense',   singular: 'Travel Request' },
  rfp:           { label: 'RFP Analysis',       singular: 'RFP' },
  insights:      { label: 'AI Insights',        singular: 'Insight' },
  reports:       { label: 'Reports',            singular: 'Report' },
  oems:          { label: 'OEMs',               singular: 'OEM' },
  masters:       { label: 'Masters',            singular: 'Master' },
  competitors:   { label: 'Competitors',        singular: 'Competitor' },
  approvals:     { label: 'Approvals',          singular: 'Approval' },
  document_management: { label: 'Document Management', singular: 'Document' },
  letter_management:   { label: 'Letter Management',   singular: 'Letter' },
  users:         { label: 'Users',              singular: 'User' },
  roles:         { label: 'Roles & Permissions',singular: 'Role' },
  settings:      { label: 'Settings',           singular: 'Setting' },
  integrations:  { label: 'Integrations',       singular: 'Integration' },
  alerts:        { label: 'Alerts',             singular: 'Alert' },
  notifications: { label: 'Notifications',      singular: 'Notification' },
}

export function useModuleName(key: string) {
  const { customLabels } = useModuleLabels()
  const defaults = DEFAULT_MODULE_NAMES[key] || { label: key, singular: key }
  const custom = customLabels[key]
  const label = (custom?.label && custom.label.trim()) ? custom.label : defaults.label
  // Singular fallback chain:
  // 1. explicit custom singular  →  2. custom label (covers "Client" → "Client")  →  3. default singular
  const singular = (custom?.singular && custom.singular.trim())
    ? custom.singular
    : (custom?.label && custom.label.trim())
      ? custom.label
      : defaults.singular
  return {
    label,
    singular,
    labelLower: label.toLowerCase(),
    singularLower: singular.toLowerCase(),
  }
}
