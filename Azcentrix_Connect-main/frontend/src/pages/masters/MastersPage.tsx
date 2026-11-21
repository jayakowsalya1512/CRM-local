import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Plus, Trash2, Edit2, Check, X, MapPin,
  Zap, Flame, Star, Trophy, Crown, Rocket, Target,
  Shield, Globe, Layers, Tag, List, Search, RefreshCw,
  Users,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Input from '@/components/ui/Input'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { PageHeader, useToast, FormGrid } from '@/components/ui/FormComponents'
import { requiredSelectMessage } from '@/utils/masterFieldMessages'
import { useModuleName } from '@/context/ModuleLabelsContext'
import { usePermissions } from '@/hooks/Usepermissions'
import { confirmAction } from '@/utils/sweetAlert'
import { useModalValidation } from '@/components/form/useModalValidation'
import type { SpecMap } from '@/hooks/useFieldErrors'
import { apiFieldErrors } from '@/utils/validation'
import GroupFixingPage from './GroupFixingPage'
import BusinessUnitPage from './BusinessUnitPage'
import CustomerSubSegmentPage from './CustomerSubSegmentPage'
import LocationHierarchyPage from './LocationHierarchyPage'
import QuestionnaireMasterPage from './QuestionnaireMasterPage'

// ─── Tab config ───────────────────────────────────────────────────────────────

const TABS = [
  { key: 'lead-sources',        label: 'Lead Sources',        endpoint: '/masters/lead-sources',        fields: ['name', 'description'] },
  { key: 'lead-categories',     label: 'Lead Categories',     endpoint: '/masters/lead-categories',     fields: ['name', 'description'] },
  { key: 'lead-sub-categories', label: 'Lead Sub Categories', endpoint: '/masters/lead-sub-categories', fields: ['name', 'description'] },
  { key: 'products',            label: 'Products',            endpoint: '/masters/products',            fields: ['name', 'category', 'description'] },
  // { key: 'oems',                label: 'OEMs / Vendors',      endpoint: '/masters/oems',                fields: ['name', 'contact_name', 'contact_email', 'contact_phone', 'website'] },
  { key: 'locations',           label: 'Locations',           fields: [] },
  { key: 'vertical-sectors',    label: 'Customer Segments',   endpoint: '/masters/vertical-sectors',    fields: ['name', 'description'] },
  { key: 'questionnaire',       label: 'Questionnaire',       fields: [] },
  // { key: 'groups',              label: 'Groups',              endpoint: '/masters/groups',              fields: ['name', 'description', 'icon', 'color'] },
  { key: 'group-fixing',   label: 'Groups',         endpoint: '/masters/org-tree',        fields: [] },
  { key: 'business-units', label: 'Business Verticals', endpoint: '/masters/business-units',  fields: [] },
]

const FIELD_LABELS: Record<string, string> = {
  name: 'Name', description: 'Description', website: 'Website', category: 'Category',
  contact_name: 'Contact Person', contact_email: 'Contact Email', contact_phone: 'Contact Phone',
  icon: 'Icon', color: 'Color',
}

const SALES_HEAD_ROLE_NAMES = new Set(['manager', 'sales_head'])

function isSalesHeadRoleName(role?: string) {
  return SALES_HEAD_ROLE_NAMES.has(String(role || '').toLowerCase())
}

function normalizeGroupRoleKey(role?: string) {
  const normalized = String(role || '').toLowerCase()
  return isSalesHeadRoleName(normalized) ? 'sales_head' : normalized
}

function dedupeGroupRoles(roles: { value: number; label: string; name?: string; level?: number }[]) {
  const byRole = new Map<string, { value: number; label: string; name?: string; level?: number }>()
  roles.forEach(role => {
    const key = normalizeGroupRoleKey(role.name)
    const normalizedRole = isSalesHeadRoleName(role.name)
      ? { ...role, label: 'Manager' }
      : role
    const existing = byRole.get(key)
    if (!existing || (role.name === 'sales_head' && existing.name !== 'sales_head')) {
      byRole.set(key, normalizedRole)
    }
  })
  return Array.from(byRole.values())
}

// ─── Group palette ────────────────────────────────────────────────────────────

const GROUP_ICONS = [
  { key: 'zap',    icon: <Zap size={16} />,    label: 'Zap'    },
  { key: 'flame',  icon: <Flame size={16} />,  label: 'Flame'  },
  { key: 'star',   icon: <Star size={16} />,   label: 'Star'   },
  { key: 'trophy', icon: <Trophy size={16} />, label: 'Trophy' },
  { key: 'rocket', icon: <Rocket size={16} />, label: 'Rocket' },
  { key: 'target', icon: <Target size={16} />, label: 'Target' },
  { key: 'shield', icon: <Shield size={16} />, label: 'Shield' },
  { key: 'globe',  icon: <Globe size={16} />,  label: 'Globe'  },
  { key: 'layers', icon: <Layers size={16} />, label: 'Layers' },
  { key: 'crown',  icon: <Crown size={16} />,  label: 'Crown'  },
]

const GROUP_COLORS = [
  { key: 'violet',  bg: 'bg-violet-500'  }, { key: 'blue',   bg: 'bg-blue-500'   },
  { key: 'emerald', bg: 'bg-emerald-500' }, { key: 'rose',   bg: 'bg-rose-500'   },
  { key: 'amber',   bg: 'bg-amber-500'   }, { key: 'sky',    bg: 'bg-sky-500'    },
  { key: 'pink',    bg: 'bg-pink-500'    }, { key: 'indigo', bg: 'bg-indigo-500' },
]


export const SUGGESTED_GROUP_NAMES = [
  'Alpha Squad', 'Velocity', 'Apex', 'Thunderbolt', 'Vanguard',
  'Nexus', 'Eclipse', 'Titan', 'Blaze', 'Surge', 'Phoenix', 'Orion', 'Zenith', 'Cipher', 'Nova',
]

function getIconComponent(key: string, size = 16) {
  const map: Record<string, React.ReactNode> = {
    zap:    <Zap size={size} />,    flame:  <Flame size={size} />,
    star:   <Star size={size} />,   trophy: <Trophy size={size} />,
    rocket: <Rocket size={size} />, target: <Target size={size} />,
    shield: <Shield size={size} />, globe:  <Globe size={size} />,
    layers: <Layers size={size} />, crown:  <Crown size={size} />,
  }
  return map[key] ?? <Zap size={size} />
}

function getColorBg(key: string) {
  return GROUP_COLORS.find(c => c.key === key)?.bg ?? 'bg-violet-500'
}

function getItemInitial(name?: string) {
  return String(name || '').trim().match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() || '?'
}

export function GroupBadge({ icon, color, name, size = 'sm' }: {
  icon: string; color: string; name: string; size?: 'sm' | 'lg'
}) {
  const pad = size === 'lg' ? 'w-10 h-10' : 'w-7 h-7'
  const txt = size === 'lg' ? 'text-sm font-bold' : 'text-xs font-semibold'
  return (
    <div className="flex items-center gap-2">
      <div className={`${pad} rounded-xl ${getColorBg(color)} flex items-center justify-center text-white flex-shrink-0`}>
        {getIconComponent(icon, size === 'lg' ? 18 : 14)}
      </div>
      <span className={`${txt} text-gray-800`}>{name}</span>
    </div>
  )
}

// ─── Inline master form ──────────────────────────────────────────────────────

function InlineMasterForm({ open, title, label, count, onClose, children }: {
  open: boolean; title: string; label: string; count: number
  onClose: () => void; children: React.ReactNode
}) {
  if (!open) return null

  return (
    <Card className="mb-4 w-full max-w-lg overflow-hidden border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</p>
          <p className="text-xs font-medium text-slate-300">{count} configured</p>
        </div>
      </div>
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-600">{title}</p>
          <button onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close form"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </Card>
  )
}

// ─── Field validation (same rules as masters_router SimpleItem / LeadCategoryIn / LeadSubCategoryIn / ProductIn) ──

/** Props a form body spreads onto each validated input: element id, error message (red border + text), onBlur. */
interface FieldProps {
  input: (k: string) => { id: string; error?: string; onBlur: () => void; 'aria-invalid'?: true }
  err: (k: string) => string | undefined
}

function masterSpecs(tabKey: string): SpecMap {
  const nameLabel = tabKey === 'lead-sub-categories' ? 'Sub category name' : tabKey === 'products' ? 'Product name' : 'Name'
  const descMax = tabKey === 'lead-categories' || tabKey === 'lead-sub-categories' ? 255 : 1000
  const specs: SpecMap = {
    name: { label: nameLabel, rule: 'name', required: true, min: 2, max: tabKey === 'products' ? 300 : 100 },
    description: { label: 'Description', rule: 'text', max: descMax },
  }
  if (tabKey === 'products') specs.category = { label: 'Category', rule: 'text', max: 100 }
  if (tabKey === 'lead-sub-categories') specs.category_id = { label: 'Lead category', rule: 'select', required: true }
  // keep the on-screen order so submit focuses the first invalid field
  return Object.fromEntries(MASTER_FIELD_ORDER.filter(k => specs[k]).map(k => [k, specs[k]]))
}

const MASTER_FIELD_ORDER = ['category_id', 'name', 'category', 'description']

// ─── Form footer ──────────────────────────────────────────────────────────────

function DrawerFooter({ onSave, onCancel, saving, editId }: {
  onSave: () => void; onCancel: () => void; saving: boolean; editId: number | null
}) {
  return (
    <div className="flex gap-3 mt-8 pt-5 border-t border-gray-100">
      <Button onClick={onSave} loading={saving} className="flex-1 justify-center">
        <Check size={14} className="mr-1.5 inline-block" />
        {editId ? 'Save Changes' : 'Create'}
      </Button>
      <Button variant="ghost" onClick={onCancel} className="px-5">Cancel</Button>
    </div>
  )
}

// ─── Form bodies ──────────────────────────────────────────────────────────────

function OEMFormBody({ form, setForm, products }: {
  form: Record<string, any>; setForm: (f: Record<string, any>) => void
  products: { value: number; label: string }[]
}) {
  const sf = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          Product <span className="text-xs text-gray-400 font-normal ml-1">— which product this OEM supplies</span>
        </label>
        <SearchableSelect options={products} value={form.product_id ?? null}
          onChange={v => setForm({ ...form, product_id: v })} placeholder="Select product…" />
      </div>
      <Input label="OEM / Vendor Name *" value={form.name ?? ''} onChange={sf('name')} required />
      <FormGrid cols={2}>
        <Input label="Contact Person" value={form.contact_name  ?? ''} onChange={sf('contact_name')}  />
        <Input label="Contact Phone"  value={form.contact_phone ?? ''} onChange={sf('contact_phone')} />
        <Input label="Contact Email"  value={form.contact_email ?? ''} onChange={sf('contact_email')} />
        <Input label="Website"        value={form.website       ?? ''} onChange={sf('website')}        />
      </FormGrid>
    </div>
  )
}

function StateFormBody({ form, setForm, regions }: {
  form: Record<string, any>; setForm: (f: Record<string, any>) => void
  regions: { value: number; label: string }[]
}) {
  const sf = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <div className="space-y-4">
      <SearchableSelect label="Region" options={regions} value={form.region_id ?? null}
        onChange={v => setForm({ ...form, region_id: v })} placeholder="Select region…" clearable />
      <Input label="State Name *"  value={form.name        ?? ''} onChange={sf('name')}        required placeholder="e.g. Maharashtra" />
      <Input label="Description"   value={form.description ?? ''} onChange={sf('description')} />
    </div>
  )
}

function LeadSubCatFormBody({ form, setForm, leadCategories, fv }: {
  form: Record<string, any>; setForm: (f: Record<string, any>) => void
  leadCategories: { value: number; label: string }[]
  fv?: FieldProps
}) {
  const sf = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <div className="space-y-4">
      <div id="mf-category_id">
        <SearchableSelect label="Lead Category *" options={leadCategories} value={form.category_id ?? null}
          onChange={v => setForm({ ...form, category_id: v })} placeholder="Select category…" error={fv?.err('category_id')} />
      </div>
      <Input label="Sub Category Name *" value={form.name        ?? ''} onChange={sf('name')}        required placeholder="e.g. Enterprise SaaS" {...fv?.input('name')} />
      <Input label="Description"         value={form.description ?? ''} onChange={sf('description')} {...fv?.input('description')} />
    </div>
  )
}

// ── GroupFormBody — state is now a SearchableSelect filtered by region ─────────
function GroupFormBody({
  form,
  setForm,
  regions,
  states,
  roles,
  allUsers,
  editId,
}: {
  form: any
  setForm: React.Dispatch<React.SetStateAction<any>>
  regions: { value: number; label: string }[]
  states: { value: number; label: string; region_id?: number }[]
  roles: { value: number; label: string; name?: string; level?: number }[]
  allUsers: any[]
  editId?: number | null
}) {
  const filteredStates = useMemo(() => {
    if (!form.region_id) return []

    return states.filter(
      s => Number(s.region_id) === Number(form.region_id)
    )
  }, [states, form.region_id])

  const reportingUsers = useMemo(() => {
  return allUsers
    .filter((u: any) =>
      ['manager', 'sales_head', 'vp'].includes(
        String(u.role || '').toLowerCase()
      )
    )
    .map((u: any) => ({
      value: u.value,
      label: u.label,
      role: String(u.role || '').toLowerCase(),
      region_id: u.region_id ?? null,
      state_id: u.state_id ?? null,
    }))
}, [allUsers])

const availableUsers = (role: string) => {
  return reportingUsers.filter((u: any) => {
    const userRole = u.role === 'sales_head' ? 'manager' : u.role
    const selectedRole = role === 'sales_head' ? 'manager' : role

    return userRole === selectedRole
  })
}

  return (
    <div className="space-y-6">

      {/* GROUP INFO */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">
          Group Information
        </h3>

        <FormGrid cols={2}>
          <Input
            label="Group Name"
            value={form.name || ''}
            onChange={(e) =>
              setForm((p: any) => ({
                ...p,
                name: e.target.value,
              }))
            }
            placeholder="Enter group name..."
            required
          />

          <Input
            label="Description"
            value={form.description || ''}
            onChange={(e) =>
              setForm((p: any) => ({
                ...p,
                description: e.target.value,
              }))
            }
            placeholder="Enter description..."
          />
        </FormGrid>
      </div>

      {/* REGION & STATE */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">
          Region & State
        </h3>

        <FormGrid cols={2}>
          <SearchableSelect
            label="Region"
            options={regions}
            value={form.region_id ?? null}
            onChange={(v: any) => {
              setForm((p: any) => ({
                ...p,
                region_id: v ? Number(v) : null,
                state_id: null,
              }))
            }}
            clearable
            placeholder="Select region..."
          />

          <SearchableSelect
            label="State"
            options={filteredStates}
            value={form.state_id ?? null}
            onChange={(v: any) => {
              setForm((p: any) => ({
                ...p,
                state_id: v ? Number(v) : null,
              }))
            }}
            clearable
            placeholder={
              form.region_id
                ? 'Select state...'
                : 'Select region first'
            }
          />
        </FormGrid>
      </div>

      {/* REPORTING HIERARCHY */}
      <div>
        <h3 className="text-sm font-semibold text-gray-800 mb-3">
          Reporting Hierarchy
        </h3>

        <div className="mb-3 rounded-lg border border-sky-100 bg-sky-50 p-3">
          <p className="text-xs text-sky-700">
            Add Sales Heads and VPs for this group.
          </p>
        </div>

        <div className="space-y-3">
          {(form.reporting_hierarchy || []).map(
            (row: any, index: number) => {
              const isReadonly = !!editId && row.is_existing
const selectedUser = reportingUsers.find(
  (u: any) => Number(u.value) === Number(row.reporting_user_id)
)
              const roleUsers = availableUsers(
                row.reporting_role
              )

              return (
                <div
                  key={index}
                  className="rounded-xl border border-gray-200 bg-gray-50 p-3"
                >
                  <FormGrid cols={2}>

                    {/* ROLE */}
                    {isReadonly ? (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1.5">
      Reporting Role
    </label>
    <div className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">
      {row.reporting_role === 'vp' ? 'VP' : 'Sales Head'}
    </div>
  </div>
) : (
  <SearchableSelect
    label="Reporting Role"
    value={row.reporting_role}
    options={[
      { value: 'manager', label: 'Sales Head' },
      { value: 'vp', label: 'VP' },
    ]}
    onChange={(v: any) => {
      const role = String(v || 'manager')

      setForm((p: any) => ({
        ...p,
        reporting_hierarchy: p.reporting_hierarchy.map((x: any, i: number) =>
          i === index
            ? {
                ...x,
                reporting_role: role,
                reporting_user_id: 0,
                level: index + 1,
              }
            : x
        ),
      }))
    }}
  />
)}

                    {/* USER */}
                    {isReadonly ? (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1.5">
      {row.reporting_role === 'vp' ? 'Selected VP' : 'Selected Sales Head'}
    </label>
    <div className="rounded-lg border border-gray-200 bg-gray-100 px-3 py-2 text-sm text-gray-700">
      {selectedUser?.label || `User #${row.reporting_user_id}`}
    </div>
  </div>
) : (
  <SearchableSelect
    label={row.reporting_role === 'vp' ? 'Select VP' : 'Select Sales Head'}
    value={row.reporting_user_id || null}
    options={roleUsers}
    onChange={(v: any) => {
      setForm((p: any) => ({
        ...p,
        reporting_hierarchy: p.reporting_hierarchy.map((x: any, i: number) =>
          i === index
            ? {
                ...x,
                reporting_user_id: Number(v || 0),
                level: index + 1,
              }
            : x
        ),
      }))
    }}
    clearable
    placeholder="Select user..."
    hint={roleUsers.length ? `${roleUsers.length} user(s) available` : 'No users found'}
  />
)}
                  </FormGrid>

                  <div className="mt-3">
  <label className="inline-flex items-center gap-2 text-xs font-medium text-gray-700">
    <input
      type="checkbox"
      checked={!!row.is_group_lead}
      disabled={
        !row.is_group_lead &&
        (form.reporting_hierarchy || []).some((x: any) => x.is_group_lead)
      }
      onChange={(e) => {
        const checked = e.target.checked

        setForm((p: any) => ({
          ...p,
          reporting_hierarchy: p.reporting_hierarchy.map((x: any, i: number) => ({
            ...x,
            is_group_lead: i === index ? checked : false,
          })),
        }))
      }}
    />
    Group Lead
  </label>
</div>

                  {/* REMOVE */}
                  <div className="mt-3 flex justify-end">
                   <button
  type="button"
  onClick={async () => {
    if (editId && row.reporting_user_id) {
      await api.delete(
        `/masters/groups/${editId}/reporting-hierarchy/${row.reporting_user_id}`
      )
    }

    setForm((p: any) => ({
      ...p,
      reporting_hierarchy: p.reporting_hierarchy
        .filter((_: any, i: number) => i !== index)
        .map((x: any, i: number) => ({
          ...x,
          level: i + 1,
        })),
    }))
  }}
  className="text-xs font-medium text-red-600 hover:text-red-700"
>
  Remove
</button>
                  </div>
                </div>
              )
            }
          )}

          {/* ADD BUTTON */}
          <button
            type="button"
            onClick={() => {
              setForm((p: any) => ({
                ...p,
                reporting_hierarchy: [
                  ...(p.reporting_hierarchy || []),
                  {
  reporting_user_id: 0,
  reporting_role: 'manager',
  level: (p.reporting_hierarchy || []).length + 1,
  is_existing: false,
},
                ],
              }))
            }}
            className="w-full rounded-lg border border-dashed border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100"
          >
            + Add Reporting Person
          </button>
        </div>
      </div>
    </div>
  )
}




function SimpleFormBody({ fields, form, setForm, fv }: {
  fields: string[]; form: Record<string, any>; setForm: (f: Record<string, any>) => void
  fv?: FieldProps
}) {
  const sf = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <div className="space-y-4">
      {fields.map(f => (
        <Input key={f} label={FIELD_LABELS[f] || f} value={form[f] ?? ''} onChange={sf(f)} required={f === 'name'} {...fv?.input(f)} />
      ))}
    </div>
  )
}

// ─── Row Actions ──────────────────────────────────────────────────────────────

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex gap-1 flex-shrink-0 ml-3 opacity-0 group-hover:opacity-100 transition-opacity">
      <button onClick={onEdit}
        className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors">
        <Edit2 size={14} />
      </button>
      <button onClick={onDelete}
        className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
        <Trash2 size={14} />
      </button>
    </div>
  )
}

// ─── List Rows ────────────────────────────────────────────────────────────────

function RegionRow({ item, onEdit, onDelete }: { item: any; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors group">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-sky-100 flex items-center justify-center text-sky-600 flex-shrink-0">
          <MapPin size={14} />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">{item.name}</p>
          <div className="flex gap-3 mt-0.5">
            {item.description  && <span className="text-xs text-gray-400">{item.description}</span>}
            {item.group_count != null && <span className="text-xs text-sky-600 font-medium">{item.group_count} groups</span>}
          </div>
        </div>
      </div>
      <RowActions onEdit={onEdit} onDelete={onDelete} />
    </div>
  )
}

function StateRow({ item, onEdit, onDelete }: { item: any; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors group">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-600 flex-shrink-0">
          <MapPin size={14} />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">{item.name}</p>
          <div className="flex gap-3 mt-0.5">
            {item.region_name && <span className="text-xs text-sky-600 font-medium">📍 {item.region_name}</span>}
            {item.description && <span className="text-xs text-gray-400">{item.description}</span>}
          </div>
        </div>
      </div>
      <RowActions onEdit={onEdit} onDelete={onDelete} />
    </div>
  )
}

function LeadSubCategoryRow({ item, onEdit, onDelete }: { item: any; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors group">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center text-indigo-600 flex-shrink-0">
          <List size={14} />
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-900">{item.name}</p>
          <div className="flex gap-3 mt-0.5">
            {item.category_name && (
              <span className="inline-flex items-center gap-1 text-xs text-indigo-600 font-medium">
                <Tag size={10} />{item.category_name}
              </span>
            )}
            {item.description && <span className="text-xs text-gray-400">{item.description}</span>}
          </div>
        </div>
      </div>
      <RowActions onEdit={onEdit} onDelete={onDelete} />
    </div>
  )
}


// ── GroupRow — shows state_name resolved from FK ───────────────────────────────
function GroupRow({ item, onEdit, onDelete }: { item: any; onEdit: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false)

  const isVP = item.role === 'vp'
  const roleLbl = isSalesHeadRoleName(item.role) ? 'Manager' : (item.role_name || item.role)
  const members = Array.isArray(item.members) ? item.members : []

  const sortedMembers = [...members].sort((a: any, b: any) => {
  const order = (m: any) =>
    m.is_group_lead ? 0 :
    ['manager', 'sales_head'].includes(String(m.role || '').toLowerCase()) ? 1 :
    String(m.role || '').toLowerCase() === 'sales' ? 2 :
    3

  return order(a) - order(b)
})
  
  return (
    <div className="px-5 py-3.5 hover:bg-gray-50 transition-colors group">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`w-9 h-9 rounded-xl ${getColorBg(item.color ?? 'violet')} flex items-center justify-center text-white flex-shrink-0`}>
            {getIconComponent(item.icon ?? 'zap', 16)}
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-bold text-gray-900">{item.name}</p>

              {roleLbl && (
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border
                  ${isVP
                    ? 'bg-amber-100 text-amber-700 border-amber-200'
                    : 'bg-blue-100 text-blue-700 border-blue-200'}`}>
                  {roleLbl}
                </span>
              )}

              {item.region_names?.map((rn: string, i: number) => (
                <span key={`r-${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-100 text-sky-700 border border-sky-200">
                  <MapPin size={9} />{rn}
                </span>
              ))}

              {item.state_names?.map((sn: string, i: number) => (
                <span key={`s-${i}`} className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                  {sn}
                </span>
              ))}
            </div>

            <div className="flex gap-3 mt-0.5 flex-wrap items-center">
              {item.manager_name && (
                <span className="text-xs text-purple-600 font-medium">
                  👤 Group Lead: {item.manager_name}
                </span>
              )}

              <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="inline-flex items-center gap-1 text-xs text-emerald-600 font-semibold hover:text-emerald-700 hover:underline"
              >
                <Users size={12} />
                {item.member_count ?? 0} person(s)
              </button>

              {item.sales_count != null && (
                <span className="text-xs text-blue-600 font-medium">
                  🧑‍💼 {item.sales_count} sales
                </span>
              )}

              {item.description && (
                <span className="text-xs text-gray-400">{item.description}</span>
              )}
            </div>
          </div>
        </div>

        <RowActions onEdit={onEdit} onDelete={onDelete} />
      </div>

      {open && (
        <div className="mt-3 ml-12 rounded-xl border border-gray-100 bg-white shadow-sm overflow-hidden">
          {members.length === 0 ? (
            <div className="px-4 py-3 text-xs text-gray-400 italic">
              No team members found for this group.
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {sortedMembers.map((m: any) => (
                <div
                  key={m.id}
                  className={`flex items-center justify-between px-4 py-2.5 ${
                    m.is_group_lead
                      ? 'bg-amber-50'
                      : m.is_sales
                      ? 'bg-emerald-50/50'
                      : 'bg-white'
                  }`}
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{m.name}</p>
                    <p className="text-xs text-gray-400">{m.email || 'No email'}</p>
                  </div>

                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                    m.is_group_lead
                      ? 'bg-amber-100 text-amber-700 border-amber-200'
                      : 'bg-emerald-100 text-emerald-700 border-emerald-200'
                  }`}>
{m.is_group_lead
  ? `Group Lead - ${m.role_name || m.role || ''}`
  : m.role_name || m.role}
                    </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GenericRow({ item, fields, onEdit, onDelete }: {
  item: any; fields: string[]; onEdit: () => void; onDelete: () => void
}) {
  const subtitles = fields
    .filter(f => f !== 'name' && item[f])
    .map(f => `${FIELD_LABELS[f] || f}: ${item[f]}`)
  return (
    <div className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors group">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-sm flex-shrink-0">
          {getItemInitial(item.name)}
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">{item.name}</p>
          <div className="flex gap-3 mt-0.5 flex-wrap">
            {subtitles.map((t, i) => <span key={i} className="text-xs text-gray-400">{t}</span>)}
          </div>
        </div>
      </div>
      <RowActions onEdit={onEdit} onDelete={onDelete} />
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MastersPage() {
  const { label: mastersLabel } = useModuleName('masters')
  const [activeTab, setActiveTab]           = useState('lead-sources')
  const [data, setData]                     = useState<any[]>([])
  const [loading, setLoading]               = useState(true)
  const [drawerOpen, setDrawerOpen]         = useState(false)
  const [locationReloadKey, setLocationReloadKey] = useState(0)
  const [questionnaireReloadKey, setQuestionnaireReloadKey] = useState(0)
  const [editId, setEditId]                 = useState<number | null>(null)
  const [form, setForm]                     = useState<Record<string, any>>({})
  const [saving, setSaving]                 = useState(false)
  const [search, setSearch]                 = useState('')
  const [products, setProducts]             = useState<{ value: number; label: string }[]>([])
  const [regions, setRegions]               = useState<{ value: number; label: string }[]>([])
  const [states, setStates]                 = useState<{ value: number; label: string; region_id?: number }[]>([])
  const [leadCategories, setLeadCategories] = useState<{ value: number; label: string }[]>([])
  const [managers, setManagers]             = useState<{ value: number; label: string; subtitle?: string; role?: string }[]>([])
  const [roles, setRoles]                   = useState<{ value: number; label: string; name?: string; level?: number }[]>([])
  const { success, error: showError }       = useToast()
  const { can }                             = usePermissions()

  const visibleTabs = useMemo(
    () => TABS.filter(t => t.key !== 'questionnaire' || can('questionnaire.view')),
    [can],
  )
  const currentTabKey = visibleTabs.some(t => t.key === activeTab)
    ? activeTab
    : visibleTabs[0]?.key ?? activeTab
  const tab          = visibleTabs.find(t => t.key === currentTabKey) ?? TABS[0]
  const isOEM        = currentTabKey === 'oems'
  const isGroup      = currentTabKey === 'groups'
  const isLeadSubCat = currentTabKey === 'lead-sub-categories'
  const singular     = tab.label.endsWith('ies')
    ? tab.label.slice(0, -3) + 'y'
    : tab.label.endsWith('s') ? tab.label.slice(0, -1) : tab.label
 
  useEffect(() => {
    if (currentTabKey !== activeTab) setActiveTab(currentTabKey)
  }, [activeTab, currentTabKey])

  // ── field validation for the inline add / edit form ──
  const normName = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  const dupExtra = (f: Record<string, any>): Record<string, string> => {
    const n = normName(f.name)
    if (!n || !tab.endpoint || currentTabKey === 'group-fixing' || currentTabKey === 'business-units') return {}
    const hit = data.some((it: any) => it.id !== editId && normName(it.name) === n
      && (!isLeadSubCat || Number(it.category_id) === Number(f.category_id)))
    if (!hit) return {}
    return { name: isLeadSubCat ? 'This sub category already exists under the selected lead category.' : `A ${singular.toLowerCase()} with this name already exists.` }
  }
  const fval = useModalValidation(form, () => masterSpecs(currentTabKey), dupExtra,
    Object.fromEntries(MASTER_FIELD_ORDER.map(k => [k, `mf-${k}`])))
  const fieldProps: FieldProps = {
    input: k => ({ id: `mf-${k}`, error: fval.errors[k], onBlur: () => fval.blur(k), ...(fval.errors[k] ? { 'aria-invalid': true as const } : {}) }),
    err: k => fval.errors[k],
  }
  /** setForm for the form bodies: also re-validates the fields that changed. */
  const setFormValidated = (next: Record<string, any>) => {
    const changed = Object.keys({ ...form, ...next }).filter(k => form[k] !== next[k])
    setForm(next)
    fval.change(next, ...changed)
  }


  const filtered = useMemo(() => {
    if (!search.trim()) return data
    const q = search.toLowerCase()
    return data.filter(item =>
      Object.values(item).some(v => v != null && String(v).toLowerCase().includes(q))
    )
  }, [data, search])

  // Load all select options on mount
  useEffect(() => {
    api.get('/masters/products')
      .then(r => setProducts((r.data as any[]).filter(x => x.name).map(x => ({ value: x.id, label: x.name }))))
      .catch(() => {})
    api.get('/masters/regions')
      .then(r => setRegions((r.data as any[]).map(x => ({ value: x.id, label: x.name }))))
      .catch(() => {})
    api.get('/masters/states')
      .then(r => setStates((r.data as any[]).map(x => ({
        value:     x.id,
        label:     x.name,
        region_id: x.region_id ?? null,
      }))))
      .catch(() => {})
    api.get('/masters/lead-categories')
      .then(r => setLeadCategories((r.data as any[]).map(x => ({ value: x.id, label: x.name }))))
      .catch(() => {})
    api.get('/masters/users-for-select?roles=manager,sales_head,vp')
  .then(r =>
    setManagers(
      (r.data as any[]).map(x => ({
        value: x.id,
        label: x.label,
        subtitle: x.subtitle,
        role: x.role,
        region_id: x.region_id ?? null,
        state_id: x.state_id ?? null,
      }))
    )
  )
  .catch(() => {})
    api.get('/masters/roles-for-select?names=vp,manager')
      .then(r => setRoles(dedupeGroupRoles(r.data as any[])))
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!tab.endpoint) {
      setLoading(false)
      return
    }
    setLoading(true)
    try   { const r = await api.get(tab.endpoint); setData(r.data) }
    catch { showError('Failed to load') }
    finally { setLoading(false) }
  }, [tab.endpoint, showError])

  const clearFieldErrors = fval.clear
  useEffect(() => {
    setDrawerOpen(false)
    setForm({})
    setEditId(null)
    setSearch('')
    clearFieldErrors()
    if (currentTabKey === 'locations' || currentTabKey === 'vertical-sectors' || currentTabKey === 'questionnaire') {
      setLoading(false)
      return
    }
    load()
  }, [currentTabKey, load, clearFieldErrors])

  // Keep region/category selects in sync when their tab data reloads
  useEffect(() => {
    if (currentTabKey === 'regions')         setRegions(data.map((x: any) => ({ value: x.id, label: x.name })))
    if (currentTabKey === 'states')          setStates(data.map((x: any) => ({ value: x.id, label: x.name, region_id: x.region_id ?? null })))
    if (currentTabKey === 'lead-categories') setLeadCategories(data.map((x: any) => ({ value: x.id, label: x.name })))
  }, [currentTabKey, data])

 const handleSave = async () => {
    if (isLeadSubCat && !form.category_id && !leadCategories.length) { showError(requiredSelectMessage('Lead Category', leadCategories)); return }
    // field-level check: every message is shown under its field and the first invalid field is focused
    if (!isGroup && !isOEM && !fval.submit()) return
    const endpoint = tab.endpoint
    if (!endpoint)                                { showError('This master tab is managed in its own screen'); return }
    setSaving(true)
    try {
      let payload = { ...form }


      // Group: convert form state → API string format
      if (isGroup) {
        const selectedRole = roles.find((r: any) => r.value === form.role_id)
        const roleIsVP = selectedRole?.name === 'vp'
        if (roleIsVP) {
          payload.region_id = (form.region_ids ?? []).join(',') || null
          payload.state_id  = (form.state_ids  ?? []).join(',') || null
        } else {
          payload.region_id = form.region_id ? String(form.region_id) : null
          payload.state_id  = form.state_id  ? String(form.state_id)  : null
        }
        delete payload.region_ids
        delete payload.state_ids
        delete payload.role   // legacy string field — not sent
        const reportingRows = (form.reporting_hierarchy || [])
  .filter((x: any) => x.reporting_user_id && x.reporting_role)

if (reportingRows.length > 0) {
  const leadRows = reportingRows.filter((x: any) => x.is_group_lead)

  if (leadRows.length === 0) {
    showError('Please select one Group Lead from the reporting managers')
    setSaving(false)
    return
  }

  if (leadRows.length > 1) {
    showError('Only one Group Lead can be selected')
    setSaving(false)
    return
  }
}
        payload.reporting_hierarchy = reportingRows.map((x: any, index: number) => ({
  reporting_user_id: Number(x.reporting_user_id),
  reporting_role: x.reporting_role,
  level: index + 1,
  is_group_lead: !!x.is_group_lead,
}))
      }

      if (editId) { await api.put(`${endpoint}/${editId}`, payload); success('Updated successfully') }
      else        { await api.post(endpoint, payload);               success('Created successfully') }
      setDrawerOpen(false); setForm({}); setEditId(null); fval.clear(); load()
    } catch (e: any) {
      // server field errors (format, duplicates) land under their fields; anything else is a toast
      if (!fval.server(e)) {
        const d = e?.response?.data?.detail
        showError(typeof d === 'string' ? d : Object.values(apiFieldErrors(e))[0] || 'Save failed')
      }
    } finally { setSaving(false) }
  }

  const handleDelete = async (id: number) => {
    const endpoint = tab.endpoint
    if (!endpoint) return
    const confirmed = await confirmAction({
      title: 'Delete item?',
      text: 'This item will be removed.',
      confirmButtonText: 'Delete',
      icon: 'warning',
    })
    if (!confirmed) return
    try   { await api.delete(`${endpoint}/${id}`); success('Deleted'); load() }
    catch (e: any) { showError(e.response?.data?.detail || 'Failed to delete') }
  }

  const startEdit = async (item: any) => {
    setEditId(item.id)
    const f: Record<string, any> = {}
    tab.fields.forEach(k => { f[k] = item[k] ?? '' })
    if (isOEM)        { f.product_id  = item.product_id  ?? null }
    if (isLeadSubCat) { f.category_id = item.category_id ?? null }
    if (isGroup) {
      // item.role is the role name string resolved by list_groups — reliable, no API race
      f.role_id    = item.role_id != null ? Number(item.role_id) : null
      f.manager_id = item.manager_id      ?? null
      f.icon       = item.icon            ?? 'zap'
      f.color      = item.color           ?? 'violet'
      const parseIds = (s: string | null | undefined) =>
        s ? String(s).split(',').map(Number).filter(Boolean) : []
      if (item.role === 'vp') {
        f.region_ids = parseIds(item.region_id)
        f.state_ids  = parseIds(item.state_id)
      } else {
        f.region_id = parseIds(item.region_id)[0] ?? null
        f.state_id  = parseIds(item.state_id)[0]  ?? null
      }
      f.reporting_hierarchy = []

try {
  const res = await api.get(`/masters/groups/${item.id}/reporting-hierarchy`)

f.reporting_hierarchy = Array.isArray(res.data)
  ? res.data.map((x: any, index: number) => ({
      reporting_user_id: Number(x.reporting_user_id),
      reporting_role: x.reporting_role,
      level: Number(x.level || index + 1),
      is_existing: true,
is_group_lead: !!x.is_group_lead,
    }))
  : []
} catch {
  f.reporting_hierarchy = []
}
    }
    setForm(f); fval.clear(); setDrawerOpen(true)
  }

  const openAdd = () => {
    setEditId(null)
    setForm(isGroup ? { icon: 'zap', color: 'violet' } : {})
    fval.clear()
    setDrawerOpen(true)
  }

  const closeDrawer = () => { setDrawerOpen(false); setForm({}); setEditId(null); fval.clear() }

  const handleHeaderReload = () => {
  if (currentTabKey === 'locations') {
    setLocationReloadKey((prev) => prev + 1)
    return
  }

  if (currentTabKey === 'questionnaire') {
    setQuestionnaireReloadKey((prev) => prev + 1)
    return
  }

  load()
}

  const drawerTitle = `${editId ? 'Edit' : 'Add'} ${singular}`
  const formBody = isOEM        ? <OEMFormBody form={form} setForm={setForm} products={products} />
               : isLeadSubCat ? <LeadSubCatFormBody form={form} setForm={setFormValidated} leadCategories={leadCategories} fv={fieldProps} />
               : isGroup      ? <GroupFormBody form={form} setForm={setForm} regions={regions} roles={roles} allUsers={managers} states={states} editId={editId} />
               :                <SimpleFormBody fields={tab.fields} form={form} setForm={setFormValidated} fv={fieldProps} />

  return (
    <div className="p-6">
      <PageHeader
  title={mastersLabel}
  subtitle={`Manage all lookup data used across the CRM`}
  breadcrumb={['Settings', mastersLabel]}
  actions={
    <button
      type="button"
      onClick={handleHeaderReload}
      className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"
      title="Reload"
    >
      <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
    </button>
  }
/>
      {/* Tab bar */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
        {visibleTabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all
              ${currentTabKey === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {currentTabKey === 'locations' ? (
  <div className="h-[calc(100vh-210px)] min-h-0 overflow-hidden">
    <LocationHierarchyPage
      embedded
      reloadKey={locationReloadKey}
      onDataChange={({ regions: nextRegions, states: nextStates }) => {
        setRegions(nextRegions.map((x: any) => ({ value: x.id, label: x.name })))
        setStates(nextStates.map((x: any) => ({
          value: x.id,
          label: x.name,
          region_id: x.region_id ?? null,
        })))
      }}
    />
  </div>
) : currentTabKey === 'group-fixing' ? (
        <GroupFixingPage embedded />
      ) : currentTabKey === 'business-units' ? (
        <BusinessUnitPage embedded />
      ) : currentTabKey === 'vertical-sectors' ? (
        <CustomerSubSegmentPage embedded />
      ) : currentTabKey === 'questionnaire' ? (
        <QuestionnaireMasterPage embedded reloadKey={questionnaireReloadKey} />
      ) : (
        <>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${tab.label.toLowerCase()}…`}
            className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg bg-white
              focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400
              placeholder:text-gray-400 transition-colors" />
          {search && (
            <button onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X size={14} />
            </button>
          )}
        </div>
        <p className="text-sm text-gray-400 whitespace-nowrap">{filtered.length} of {data.length}</p>
        <div className="ml-auto">
          <Button onClick={openAdd}><Plus size={15} className="mr-1.5 inline-block" />Add {singular}</Button>
        </div>
      </div>

      {/* Compact add panel, matching the Customer Segments layout. */}
      <InlineMasterForm
        open={drawerOpen}
        title={drawerTitle}
        label={tab.label}
        count={data.length}
        onClose={closeDrawer}
      >
        {formBody}
        <DrawerFooter onSave={handleSave} onCancel={closeDrawer} saving={saving} editId={editId} />
      </InlineMasterForm>

      {/* List */}
      <Card>
        {loading ? (
          <div className="p-10 text-center text-sm text-gray-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-14 text-center">
            <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-3">
              {search ? <Search size={20} className="text-gray-400" /> : <Plus size={20} className="text-gray-400" />}
            </div>
            <p className="text-sm text-gray-500 mb-3">
              {search ? `No results for "${search}"` : `No ${tab.label} configured yet`}
            </p>
            {!search && <Button onClick={openAdd}><Plus size={14} className="mr-1 inline-block" />Add First {singular}</Button>}
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map((item: any) => {
              const props = { item, onEdit: () => startEdit(item), onDelete: () => handleDelete(item.id) }
              if (isGroup)      return <GroupRow           key={item.id} {...props} />
              if (isLeadSubCat) return <LeadSubCategoryRow key={item.id} {...props} />
              return <GenericRow key={item.id} {...props} fields={tab.fields} />
            })}
          </div>
        )}
      </Card>

        </>
      )}
    </div>
  )
}
