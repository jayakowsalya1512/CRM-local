import { useEffect, useMemo, useState } from 'react'
import {
  Plus, Save, Loader2, Check, X, RefreshCw, Search,
  ChevronDown, ChevronRight, LayoutDashboard, AlertCircle,
} from 'lucide-react'
import {
  platformApi,
  PlatformFeature,
  PlatformPlan,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'

type PlanFeatureMap = Record<number, Set<number>>

const emptyFeatureForm = {
  name: '',
  key: '',
  module: '',
  description: '',
}

// Dashboard feature keys → label + emoji for rich rendering
const DASHBOARD_META: Record<string, { label: string; emoji: string }> = {
  'dashboard.view': { label: 'Overview', emoji: '📊' },
  'dashboard.customers.view': { label: 'Customers', emoji: '👥' },
  'dashboard.leads.view': { label: 'Leads', emoji: '🎯' },
  'dashboard.tenders.view': { label: 'Tenders', emoji: '📄' },
  'dashboard.emdbg.view': { label: 'EMD / BG', emoji: '🛡️' },
  'dashboard.kam360.view': { label: 'KAM 360', emoji: '🧭' },
  'dashboard.travel.view': { label: 'Travel', emoji: '✈️' },
  'dashboard.login_tracker.view': { label: 'Login Tracker', emoji: '🔐' },
}

// One accent color scheme per plan column (cycles)
const PLAN_ACCENTS = [
  {
    header: 'bg-blue-50 border-blue-200',
    label: 'text-blue-700',
    price: 'text-blue-400',
    enabledCell: 'bg-blue-500 hover:bg-blue-600',
    disabledCell: 'bg-slate-100 hover:bg-slate-200 text-slate-400',
    badge: 'bg-blue-100 text-blue-700',
    allBtn: 'text-blue-600 hover:text-blue-800',
  },
  {
    header: 'bg-violet-50 border-violet-200',
    label: 'text-violet-700',
    price: 'text-violet-400',
    enabledCell: 'bg-violet-500 hover:bg-violet-600',
    disabledCell: 'bg-slate-100 hover:bg-slate-200 text-slate-400',
    badge: 'bg-violet-100 text-violet-700',
    allBtn: 'text-violet-600 hover:text-violet-800',
  },
  {
    header: 'bg-emerald-50 border-emerald-200',
    label: 'text-emerald-700',
    price: 'text-emerald-400',
    enabledCell: 'bg-emerald-500 hover:bg-emerald-600',
    disabledCell: 'bg-slate-100 hover:bg-slate-200 text-slate-400',
    badge: 'bg-emerald-100 text-emerald-700',
    allBtn: 'text-emerald-600 hover:text-emerald-800',
  },
  {
    header: 'bg-amber-50 border-amber-200',
    label: 'text-amber-700',
    price: 'text-amber-400',
    enabledCell: 'bg-amber-500 hover:bg-amber-600',
    disabledCell: 'bg-slate-100 hover:bg-slate-200 text-slate-400',
    badge: 'bg-amber-100 text-amber-700',
    allBtn: 'text-amber-600 hover:text-amber-800',
  },
  {
    header: 'bg-rose-50 border-rose-200',
    label: 'text-rose-700',
    price: 'text-rose-400',
    enabledCell: 'bg-rose-500 hover:bg-rose-600',
    disabledCell: 'bg-slate-100 hover:bg-slate-200 text-slate-400',
    badge: 'bg-rose-100 text-rose-700',
    allBtn: 'text-rose-600 hover:text-rose-800',
  },
]

const getAccent = (index: number) => PLAN_ACCENTS[index % PLAN_ACCENTS.length]

export default function PlatformFeatureMatrixPage() {
  const { success, error: showError } = useToast()

  const [plans, setPlans] = useState<PlatformPlan[]>([])
  const [features, setFeatures] = useState<PlatformFeature[]>([])
  const [planFeatures, setPlanFeatures] = useState<PlanFeatureMap>({})
  const [savedSnapshot, setSavedSnapshot] = useState<Record<number, number[]>>({})

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const [featureModalOpen, setFeatureModalOpen] = useState(false)
  const [featureSaving, setFeatureSaving] = useState(false)
  const [featureForm, setFeatureForm] = useState(emptyFeatureForm)

  const activePlans = useMemo(
    () => plans.filter((p) => p.is_active),
    [plans],
  )

  // Dashboard features (module === "Dashboard") shown as a special tile section
  const dashboardFeatures = useMemo(
    () => features.filter((f) => f.module?.toLowerCase() === 'dashboard'),
    [features],
  )

  // All other features rendered as a flat list, ordered by canonical nav position
  const NAV_ORDER = [
    'customers.view','questionnaire.view','leads.view','opportunities.view','tenders.view',
    'quotations.view','workorders.view','emdbg.view','kam.view',
    'travel.view','rfp.view','approvals.view','document_management.view','letter_management.view','report_engine.view','reports.view','insights.view',
    'alerts.view','notifications.view','oems.view','masters.view',
    'competitors.view','integrations.view','roles.view','users.view','settings.view','form_builder.manage','recycle_bin.view','audit_logs.view',
  ]
  const flatFeatures = useMemo(() => {
    const lower = search.trim().toLowerCase()
    const nonDash = features.filter((f) => f.module?.toLowerCase() !== 'dashboard')
    const filtered = lower
      ? nonDash.filter(
          (f) =>
            f.name.toLowerCase().includes(lower) ||
            f.key.toLowerCase().includes(lower),
        )
      : nonDash
    return [...filtered].sort((a, b) => {
      const ai = NAV_ORDER.indexOf(a.key)
      const bi = NAV_ORDER.indexOf(b.key)
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
  }, [features, search])

  const hasUnsaved = useMemo(() => {
    for (const plan of activePlans) {
      const current = Array.from(planFeatures[plan.id] || []).sort().join(',')
      const saved = (savedSnapshot[plan.id] || []).sort().join(',')
      if (current !== saved) return true
    }
    return false
  }, [planFeatures, savedSnapshot, activePlans])

  const load = async () => {
    setLoading(true)
    try {
      const [plansRes, featuresRes] = await Promise.all([
        platformApi.listPlans(),
        platformApi.listFeatures(),
      ])
      const loadedPlans = plansRes.data || []
      const loadedFeatures = featuresRes.data || []

      setPlans(loadedPlans)
      setFeatures(loadedFeatures)

      const map: PlanFeatureMap = {}
      const snapshot: Record<number, number[]> = {}

      await Promise.all(
        loadedPlans.map(async (plan) => {
          const { data } = await platformApi.getPlanFeatures(plan.id)
          const ids = data.feature_ids || []
          map[plan.id] = new Set(ids)
          snapshot[plan.id] = ids
        }),
      )

      setPlanFeatures(map)
      setSavedSnapshot(snapshot)
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to load feature matrix')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const toggleFeatureForPlan = (planId: number, featureId: number) => {
    setPlanFeatures((prev) => {
      const next = { ...prev }
      const current = new Set(next[planId] || [])
      current.has(featureId) ? current.delete(featureId) : current.add(featureId)
      next[planId] = current
      return next
    })
  }

  const toggleGroupForPlan = (planId: number, groupFeatures: PlatformFeature[], enableAll: boolean) => {
    setPlanFeatures((prev) => {
      const next = { ...prev }
      const current = new Set(next[planId] || [])
      groupFeatures.forEach((f) =>
        enableAll ? current.add(f.id) : current.delete(f.id),
      )
      next[planId] = current
      return next
    })
  }

  const toggleAllForPlan = (planId: number, enable: boolean) => {
    setPlanFeatures((prev) => {
      const next = { ...prev }
      next[planId] = enable ? new Set(features.map((f) => f.id)) : new Set()
      return next
    })
  }

  const saveAll = async () => {
    setSaving(true)
    try {
      await Promise.all(
        activePlans.map((plan) =>
          platformApi.updatePlanFeatures(plan.id, Array.from(planFeatures[plan.id] || [])),
        ),
      )
      const snap: Record<number, number[]> = {}
      activePlans.forEach((p) => { snap[p.id] = Array.from(planFeatures[p.id] || []) })
      setSavedSnapshot(snap)
      success('Feature matrix saved successfully')
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to save feature matrix')
    } finally {
      setSaving(false)
    }
  }

  const createFeature = async () => {
    const name = featureForm.name.trim()
    const key = featureForm.key.trim().toLowerCase()
    const module = featureForm.module.trim() || 'General'
    const description = featureForm.description.trim()

    if (!name || !key) {
      showError('Module name and feature key are required')
      return
    }

    setFeatureSaving(true)
    try {
      await platformApi.createFeature({
        name,
        key: key.replace(/[^a-z0-9_.]+/g, '_'),
        module,
        description: description || undefined,
      })
      success('Module created')
      setFeatureForm(emptyFeatureForm)
      setFeatureModalOpen(false)
      await load()
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to create module')
    } finally {
      setFeatureSaving(false)
    }
  }

  const toggleCollapse = (mod: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(mod) ? next.delete(mod) : next.add(mod)
      return next
    })
  }

  const enabledCount = (planId: number) => (planFeatures[planId]?.size ?? 0)
  const totalCount = features.length

  return (
    <div className="page-body space-y-5">
      {featureModalOpen && (
        <CreateFeatureModal
          form={featureForm}
          saving={featureSaving}
          onClose={() => setFeatureModalOpen(false)}
          onSave={() => void createFeature()}
          onChange={(k, v) => setFeatureForm((p) => ({ ...p, [k]: v }))}
        />
      )}

      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="page-title">Feature Matrix</h2>
          <p className="page-subtitle">
            Configure which modules are available for each plan.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-outline"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>

          <button
            type="button"
            className="btn btn-outline"
            onClick={() => setFeatureModalOpen(true)}
          >
            <Plus size={15} />
            New Module
          </button>

          <button
            type="button"
            className={`btn btn-primary relative ${hasUnsaved ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}
            onClick={() => void saveAll()}
            disabled={saving || loading || activePlans.length === 0}
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {saving ? 'Saving…' : 'Save Changes'}
            {hasUnsaved && !saving && (
              <span className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-400 border-2 border-white" />
            )}
          </button>
        </div>
      </div>

      {/* Unsaved changes banner */}
      {hasUnsaved && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          <AlertCircle size={15} />
          You have unsaved changes — click <strong className="mx-1">Save Changes</strong> to apply.
        </div>
      )}

      {/* Matrix card */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {/* Card top: title + search */}
        <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">Plan Feature Access</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Click a cell to enable or disable a module for that plan
            </p>
          </div>

          <div className="relative w-60">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search modules…"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-8 pr-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2.5 px-6 py-10 text-sm text-slate-500">
            <Loader2 size={18} className="animate-spin text-blue-500" />
            Loading feature matrix…
          </div>
        ) : activePlans.length === 0 ? (
          <div className="px-6 py-10 text-sm text-slate-500">
            No active plans found. Create a plan first.
          </div>
        ) : features.length === 0 ? (
          <div className="px-6 py-10 text-sm text-slate-500">
            No modules found. Click <strong>New Module</strong> to add one.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse" style={{ minWidth: `${300 + activePlans.length * 160}px` }}>
              <thead>
                <tr>
                  {/* Feature column header */}
                  <th className="sticky left-0 z-10 bg-white border-b border-slate-200 px-5 py-0 w-72 text-left">
                    <div className="flex items-center gap-1.5 py-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Module</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-500">
                        {features.length}
                      </span>
                    </div>
                  </th>

                  {/* Plan columns */}
                  {activePlans.map((plan, idx) => {
                    const accent = getAccent(idx)
                    const enabled = enabledCount(plan.id)
                    const allEnabled = enabled === totalCount
                    return (
                      <th
                        key={plan.id}
                        className={`border-b border-l px-4 py-0 text-center ${accent.header}`}
                      >
                        <div className="flex flex-col items-center gap-1.5 py-3">
                          <span className={`text-sm font-bold ${accent.label}`}>{plan.name}</span>
                          <span className={`text-xs font-medium ${accent.price}`}>
                            ₹{Number(plan.price_monthly || 0).toLocaleString('en-IN')}/mo
                          </span>
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${accent.badge}`}>
                            {enabled}/{totalCount} on
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleAllForPlan(plan.id, !allEnabled)}
                            className={`mt-0.5 text-xs font-medium underline underline-offset-2 transition-colors ${accent.allBtn}`}
                          >
                            {allEnabled ? 'Disable all' : 'Enable all'}
                          </button>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>

              <tbody>
                {/* Dashboard tab toggles — collapsible group at the top */}
                {dashboardFeatures.length > 0 && (
                  <ModuleGroupRows
                    moduleName="Dashboard"
                    features={dashboardFeatures}
                    plans={activePlans}
                    planFeatures={planFeatures}
                    isCollapsed={collapsed.has('Dashboard')}
                    isDashboard
                    onToggle={toggleFeatureForPlan}
                    onToggleGroup={toggleGroupForPlan}
                    onToggleCollapse={toggleCollapse}
                  />
                )}

                {/* All other modules — flat rows, no group headers */}
                {flatFeatures.map((feature) => (
                  <FlatFeatureRow
                    key={feature.id}
                    feature={feature}
                    plans={activePlans}
                    planFeatures={planFeatures}
                    onToggle={toggleFeatureForPlan}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Module Group Rows ─────────────────────────────────────────────────────── */

function ModuleGroupRows({
  moduleName,
  features,
  plans,
  planFeatures,
  isCollapsed,
  isDashboard,
  onToggle,
  onToggleGroup,
  onToggleCollapse,
}: {
  moduleName: string
  features: PlatformFeature[]
  plans: PlatformPlan[]
  planFeatures: PlanFeatureMap
  isCollapsed: boolean
  isDashboard: boolean
  onToggle: (planId: number, featureId: number) => void
  onToggleGroup: (planId: number, features: PlatformFeature[], enable: boolean) => void
  onToggleCollapse: (mod: string) => void
}) {
  return (
    <>
      {/* Group header row */}
      <tr className={isDashboard ? 'bg-blue-50/60' : 'bg-slate-50'}>
        <td
          className={`sticky left-0 z-10 border-b border-t px-4 py-2.5 ${isDashboard ? 'bg-blue-50/80 border-blue-100' : 'bg-slate-50 border-slate-100'}`}
        >
          <button
            type="button"
            onClick={() => onToggleCollapse(moduleName)}
            className="flex items-center gap-2 group"
          >
            {isCollapsed
              ? <ChevronRight size={14} className="text-slate-400 group-hover:text-slate-600 transition-colors" />
              : <ChevronDown size={14} className="text-slate-400 group-hover:text-slate-600 transition-colors" />
            }
            {isDashboard && <LayoutDashboard size={13} className="text-blue-500" />}
            <span className={`text-xs font-bold uppercase tracking-wider ${isDashboard ? 'text-blue-700' : 'text-slate-500'}`}>
              {moduleName}
            </span>
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${isDashboard ? 'bg-blue-100 text-blue-600' : 'bg-slate-200 text-slate-500'}`}>
              {features.length}
            </span>
          </button>
        </td>

        {plans.map((plan, idx) => {
          const accent = getAccent(idx)
          const allOn = features.every((f) => planFeatures[plan.id]?.has(f.id))
          const noneOn = features.every((f) => !planFeatures[plan.id]?.has(f.id))
          return (
            <td
              key={plan.id}
              className={`border-b border-t border-l px-4 py-2.5 text-center ${isDashboard ? 'border-blue-100' : 'border-slate-100'}`}
            >
              {!isCollapsed && (
                <button
                  type="button"
                  onClick={() => onToggleGroup(plan.id, features, !allOn)}
                  className={`text-[11px] font-semibold transition-colors ${accent.allBtn}`}
                >
                  {allOn ? '− All' : noneOn ? '+ All' : '+ Rest'}
                </button>
              )}
            </td>
          )
        })}
      </tr>

      {/* Feature rows (hidden when collapsed) */}
      {!isCollapsed &&
        features.map((feature) => {
          const isDashboardFeature = feature.key in DASHBOARD_META
          const meta = DASHBOARD_META[feature.key]

          return (
            <tr
              key={feature.id}
              className="border-b border-slate-100 hover:bg-slate-50/70 transition-colors"
            >
              <td className="sticky left-0 z-10 bg-white px-5 py-3.5">
                <div className="flex items-start gap-2.5">
                  {isDashboardFeature && (
                    <span className="mt-0.5 text-base leading-none">{meta.emoji}</span>
                  )}
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-slate-700">{feature.name}</span>
                      {isDashboardFeature && (
                        <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-600">
                          Dashboard
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono mt-0.5">{feature.key}</div>
                    {feature.description && (
                      <div className="text-[11px] text-slate-400 mt-0.5">{feature.description}</div>
                    )}
                  </div>
                </div>
              </td>

              {plans.map((plan, idx) => {
                const accent = getAccent(idx)
                const enabled = Boolean(planFeatures[plan.id]?.has(feature.id))

                return (
                  <td key={plan.id} className="border-l border-slate-100 px-4 py-3.5 text-center">
                    <button
                      type="button"
                      onClick={() => onToggle(plan.id, feature.id)}
                      title={enabled ? 'Click to disable' : 'Click to enable'}
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-all shadow-sm ${
                        enabled
                          ? `${accent.enabledCell} text-white shadow-md`
                          : `${accent.disabledCell}`
                      }`}
                    >
                      {enabled ? <Check size={15} strokeWidth={2.5} /> : <X size={15} />}
                    </button>
                  </td>
                )
              })}
            </tr>
          )
        })}
    </>
  )
}

/* ─── Create Feature Modal ──────────────────────────────────────────────────── */

function FlatFeatureRow({
  feature,
  plans,
  planFeatures,
  onToggle,
}: {
  feature: PlatformFeature
  plans: PlatformPlan[]
  planFeatures: PlanFeatureMap
  onToggle: (planId: number, featureId: number) => void
}) {
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50/70 transition-colors">
      <td className="sticky left-0 z-10 bg-white px-5 py-3.5">
        <div className="text-sm font-semibold text-slate-700">{feature.name}</div>
        <div className="text-[11px] text-slate-400 font-mono mt-0.5">{feature.key}</div>
        {feature.description && (
          <div className="text-[11px] text-slate-400 mt-0.5">{feature.description}</div>
        )}
      </td>
      {plans.map((plan, idx) => {
        const accent = getAccent(idx)
        const enabled = Boolean(planFeatures[plan.id]?.has(feature.id))
        return (
          <td key={plan.id} className="border-l border-slate-100 px-4 py-3.5 text-center">
            <button
              type="button"
              onClick={() => onToggle(plan.id, feature.id)}
              title={enabled ? 'Click to disable' : 'Click to enable'}
              className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-all shadow-sm ${
                enabled
                  ? `${accent.enabledCell} text-white shadow-md`
                  : accent.disabledCell
              }`}
            >
              {enabled ? <Check size={15} strokeWidth={2.5} /> : <X size={15} />}
            </button>
          </td>
        )
      })}
    </tr>
  )
}

function CreateFeatureModal({
  form,
  saving,
  onClose,
  onSave,
  onChange,
}: {
  form: typeof emptyFeatureForm
  saving: boolean
  onClose: () => void
  onSave: () => void
  onChange: (key: keyof typeof emptyFeatureForm, value: string) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-slate-900">Create Module</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Add a module that can be assigned to plans and tenants.
            </p>
          </div>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-600"
            onClick={onClose}
            disabled={saving}
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="form-label">Module Name <span className="required">*</span></label>
            <input
              className="form-control"
              value={form.name}
              onChange={(e) => {
                const value = e.target.value
                onChange('name', value)
                if (!form.key) {
                  const gen =
                    value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') +
                    '.view'
                  onChange('key', gen)
                }
              }}
              placeholder="e.g. Payment Requirements"
            />
          </div>

          <div>
            <label className="form-label">Feature Key <span className="required">*</span></label>
            <input
              className="form-control font-mono"
              value={form.key}
              onChange={(e) =>
                onChange('key', e.target.value.toLowerCase().replace(/[^a-z0-9_.]+/g, '_'))
              }
              placeholder="e.g. payment_req.view"
            />
            <p className="form-hint">Format: module.action — e.g. customers.view or reports.view</p>
          </div>

          <div>
            <label className="form-label">Category</label>
            <input
              className="form-control"
              value={form.module}
              onChange={(e) => onChange('module', e.target.value)}
              placeholder="e.g. Finance, CRM, Analytics, Dashboard"
            />
            <p className="form-hint">
              Use <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">Dashboard</code> to group
              under the dashboard section.
            </p>
          </div>

          <div>
            <label className="form-label">Description</label>
            <textarea
              className="form-control"
              rows={3}
              value={form.description}
              onChange={(e) => onChange('description', e.target.value)}
              placeholder="Short description of what this module controls…"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            {saving ? 'Creating…' : 'Create Module'}
          </button>
        </div>
      </div>
    </div>
  )
}
