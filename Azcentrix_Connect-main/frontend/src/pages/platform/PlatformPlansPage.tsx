import { useEffect, useRef, useState } from 'react'
import { Plus, Pencil, Trash2, X, AlertTriangle, Loader2, Check, RefreshCw } from 'lucide-react'
import { isApprovalQueued, platformApi, PlatformPlan } from '@/services/platformApi'
import { Card, CardHeader } from '@/components/ui/Card'
import { useToast } from '@/components/ui/FormComponents'

const emptyForm = {
  name: '',
  slug: '',
  description: '',
  price_monthly: 0,
  price_yearly: 0,
  max_users: 5,
  is_active: true,
}

type PlanForm = typeof emptyForm

// ─── Confirm Delete Modal ─────────────────────────────────────────────────────

function ConfirmDeleteModal({
  plan,
  onConfirm,
  onClose,
}: {
  plan: PlatformPlan
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [loading, setLoading] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    btnRef.current?.focus()
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const handle = async () => {
    setLoading(true)
    try { await onConfirm(); onClose() } finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 animate-in fade-in zoom-in-95">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={20} className="text-red-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-bold text-slate-900">Delete Plan</h3>
            <p className="mt-1.5 text-sm text-slate-600">
              Delete <strong>{plan.name}</strong>? This cannot be undone. The plan cannot be deleted if any tenants are using it.
            </p>
          </div>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="mt-6 flex justify-end gap-3">
          <button className="btn btn-outline" onClick={onClose} disabled={loading}>Cancel</button>
          <button ref={btnRef} className="btn btn-danger" onClick={() => void handle()} disabled={loading}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
            Delete Plan
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Plan Form (create or edit) ───────────────────────────────────────────────

export function PlanFormPanel({
  editPlan,
  onSaved,
  onCancel,
}: {
  editPlan: PlatformPlan | null
  onSaved: () => void
  onCancel: () => void
}) {
  const { success, error: showError } = useToast()
  const [form, setForm] = useState<PlanForm>(emptyForm)
  const [loading, setLoading] = useState(false)
  const isEdit = Boolean(editPlan)

  useEffect(() => {
    if (editPlan) {
      setForm({
        name: editPlan.name,
        slug: editPlan.slug,
        description: editPlan.description || '',
        price_monthly: editPlan.price_monthly,
        price_yearly: editPlan.price_yearly,
        max_users: editPlan.max_users,
        is_active: editPlan.is_active,
      })
    } else {
      setForm(emptyForm)
    }
  }, [editPlan])

  const setValue = (key: string, value: any) => setForm((prev) => ({ ...prev, [key]: value }))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const payload = {
        ...form,
        price_monthly: Number(form.price_monthly || 0),
        price_yearly: Number(form.price_yearly || 0),
        max_users: Number(form.max_users || 5),
      }
      if (isEdit && editPlan) {
        await platformApi.updatePlan(editPlan.id, payload)
        success('Plan updated')
      } else {
        await platformApi.createPlan(payload)
        success('Plan created')
        setForm(emptyForm)
      }
      onSaved()
    } catch (err: any) {
      showError(err?.response?.data?.detail || `Unable to ${isEdit ? 'update' : 'create'} plan`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title={isEdit ? `Edit: ${editPlan?.name}` : 'Create Plan'}
        subtitle={isEdit ? 'Update plan details' : 'Add a new commercial plan'}
        actions={
          isEdit ? (
            <button className="btn btn-outline btn-sm" onClick={onCancel}>
              <X size={14} /> Cancel
            </button>
          ) : undefined
        }
      />
      <form className="card-body space-y-4" onSubmit={submit}>
        <Field label="Plan Name" value={form.name} onChange={(v) => setValue('name', v)} required />
        <Field
          label="Slug"
          value={form.slug}
          onChange={(v) => setValue('slug', v.toLowerCase().replace(/[^a-z0-9_]+/g, '_'))}
          disabled={isEdit}
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monthly Price (₹)" type="number" value={form.price_monthly} onChange={(v) => setValue('price_monthly', v)} />
          <Field label="Yearly Price (₹)" type="number" value={form.price_yearly} onChange={(v) => setValue('price_yearly', v)} />
        </div>
        <Field label="Max Users" type="number" value={form.max_users} onChange={(v) => setValue('max_users', v)} />

        <div>
          <label className="form-label">Description</label>
          <textarea
            className="form-control"
            rows={3}
            value={form.description}
            onChange={(e) => setValue('description', e.target.value)}
            placeholder="Optional plan description..."
          />
        </div>

        {isEdit && (
          <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 bg-white cursor-pointer">
            <input type="checkbox" checked={Boolean(form.is_active)} onChange={(e) => setValue('is_active', e.target.checked)} />
            <span className="text-sm font-medium text-slate-700">Active</span>
          </label>
        )}

        <button className="btn btn-primary w-full" disabled={loading}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : isEdit ? <Check size={16} /> : <Plus size={16} />}
          {loading ? 'Saving...' : isEdit ? 'Update Plan' : 'Create Plan'}
        </button>
      </form>
    </Card>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function PlatformPlansPage() {
  const { success, info, error: showError } = useToast()
  const [plans, setPlans] = useState<PlatformPlan[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [editPlan, setEditPlan] = useState<PlatformPlan | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<PlatformPlan | null>(null)

  const load = async () => {
    setListLoading(true)
    try {
      const { data } = await platformApi.listPlans()
      setPlans(data)
    } catch (err: any) {
      showError(err?.response?.data?.detail || 'Unable to load plans')
    } finally {
      setListLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const handleDelete = async (plan: PlatformPlan) => {
    const { data } = await platformApi.deletePlan(plan.id)
    if (isApprovalQueued(data)) info('Sent for approval', data.message)
    else success(`Plan "${plan.name}" deleted`)
    await load()
  }

  return (
    <div className="page-body grid grid-cols-1 xl:grid-cols-3 gap-5">
      {deleteTarget && (
        <ConfirmDeleteModal
          plan={deleteTarget}
          onConfirm={() => handleDelete(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      <div className="xl:col-span-2 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="page-title">Plans</h2>
            <p className="page-subtitle">Create and manage pricing plans and usage limits</p>
          </div>
          <button className="btn btn-outline" onClick={() => void load()} disabled={listLoading}>
            <RefreshCw size={15} className={listLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        <Card>
          <CardHeader title="Available Plans" subtitle={`${plans.length} plan${plans.length !== 1 ? 's' : ''}`} />

          <div className="table-wrapper border-0 rounded-none shadow-none">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Monthly</th>
                  <th>Yearly</th>
                  <th>Max Users</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td className="font-semibold">{plan.name}</td>
                    <td className="text-slate-500 text-xs">{plan.slug}</td>
                    <td>₹{plan.price_monthly.toLocaleString()}</td>
                    <td>₹{plan.price_yearly.toLocaleString()}</td>
                    <td>{plan.max_users}</td>
                    <td>
                      <span className={plan.is_active ? 'badge badge-success' : 'badge badge-gray'}>
                        {plan.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          className="btn btn-sm btn-outline"
                          onClick={() => setEditPlan(plan)}
                          title="Edit plan"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="btn btn-sm btn-outline text-red-600 hover:bg-red-50 border-red-200"
                          onClick={() => setDeleteTarget(plan)}
                          title="Delete plan"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!plans.length && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state py-10"><p>No plans created yet</p></div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div>
        <PlanFormPanel
          editPlan={editPlan}
          onSaved={() => { void load(); if (editPlan) setEditPlan(null) }}
          onCancel={() => setEditPlan(null)}
        />
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required,
  disabled,
}: {
  label: string
  value: any
  onChange: (value: string) => void
  type?: string
  required?: boolean
  disabled?: boolean
}) {
  return (
    <div>
      <label className="form-label">{label}{required && <span className="required ml-0.5">*</span>}</label>
      <input
        className="form-control"
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
      />
    </div>
  )
}
