import { useState, useEffect, useMemo } from 'react'
import {
  Plus, Trash2, Edit2, Check, X, MapPin,
  Zap, Flame, Star, Trophy, Crown, Rocket, Target,
  Shield, Globe, Layers, Tag, List, Search, RefreshCw,
} from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import Input from '@/components/ui/Input'
import SearchableSelect from '@/components/ui/SearchableSelect'
import { PageHeader, useToast, FormGrid } from '@/components/ui/FormComponents'

// ─── Tab config ───────────────────────────────────────────────────────────────

const TABS = [
  { key: 'lead-sources',        label: 'Lead Sources',        endpoint: '/masters/lead-sources',        fields: ['name', 'description'] },
  { key: 'lead-categories',     label: 'Lead Categories',     endpoint: '/masters/lead-categories',     fields: ['name', 'description'] },
  { key: 'lead-sub-categories', label: 'Lead Sub Categories', endpoint: '/masters/lead-sub-categories', fields: ['name', 'description'] },
  { key: 'competitors',         label: 'Competitors',         endpoint: '/masters/competitors',         fields: ['name', 'website', 'description'] },
  { key: 'products',            label: 'Products',            endpoint: '/masters/products',            fields: ['name', 'category', 'description'] },
  // { key: 'oems',                label: 'OEMs / Vendors',      endpoint: '/masters/oems',                fields: ['name', 'contact_name', 'contact_email', 'contact_phone', 'website'] },
  { key: 'regions',             label: 'Regions',             endpoint: '/masters/regions',             fields: ['name', 'description'] },
  { key: 'states',              label: 'States',              endpoint: '/masters/states',              fields: ['name', 'description'] },
  { key: 'groups',              label: 'Groups',              endpoint: '/masters/groups',              fields: ['name', 'description', 'icon', 'color'] },
]

const FIELD_LABELS: Record<string, string> = {
  name: 'Name', description: 'Description', website: 'Website', category: 'Category',
  contact_name: 'Contact Person', contact_email: 'Contact Email', contact_phone: 'Contact Phone',
  icon: 'Icon', color: 'Color',
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

// ─── Side Drawer ──────────────────────────────────────────────────────────────

function Drawer({ open, title, onClose, children }: {
  open: boolean; title: string; onClose: () => void; children: React.ReactNode
}) {
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  return (
    <>
      <div onClick={onClose}
        className={`fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] transition-opacity duration-300
          ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`} />
      <div className={`fixed top-0 right-0 h-full z-50 w-full max-w-lg bg-white shadow-2xl
        flex flex-col transition-transform duration-300 ease-in-out
        ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400
              hover:text-gray-700 hover:bg-gray-100 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </>
  )
}

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

function LeadSubCatFormBody({ form, setForm, leadCategories }: {
  form: Record<string, any>; setForm: (f: Record<string, any>) => void
  leadCategories: { value: number; label: string }[]
}) {
  const sf = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <div className="space-y-4">
      <SearchableSelect label="Lead Category *" options={leadCategories} value={form.category_id ?? null}
        onChange={v => setForm({ ...form, category_id: v })} placeholder="Select category…" />
      <Input label="Sub Category Name *" value={form.name        ?? ''} onChange={sf('name')}        required placeholder="e.g. Enterprise SaaS" />
      <Input label="Description"         value={form.description ?? ''} onChange={sf('description')} />
    </div>
  )
}

// ── GroupFormBody — state is now a SearchableSelect filtered by region ─────────
function GroupFormBody({ form, setForm, regions, managers, states }: {
  form: Record<string, any>
  setForm: (f: Record<string, any>) => void
  regions:  { value: number; label: string }[]
  managers: { value: number; label: string; subtitle?: string }[]
  states:   { value: number; label: string; region_id?: number }[]
}) {
  const sf      = (k: string, v: any) => setForm({ ...form, [k]: v })
  const colorBg = getColorBg(form.color ?? 'violet')

  // Filter states by selected region; show all if no region chosen yet
  const filteredStates = form.region_id
    ? states.filter(s => !s.region_id || s.region_id === form.region_id)
    : states

  return (
    <div className="space-y-5">
      {/* Live preview */}
      <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100">
        <div className={`w-10 h-10 rounded-xl ${colorBg} flex items-center justify-center text-white flex-shrink-0`}>
          {getIconComponent(form.icon ?? 'zap', 18)}
        </div>
        <div>
          <p className="text-sm font-semibold text-gray-800">
            {form.name || <span className="text-gray-400 font-normal">Group name preview</span>}
          </p>
          <p className="text-xs text-gray-400">{form.color ?? 'violet'} · {form.icon ?? 'zap'}</p>
        </div>
      </div>

      {/* Name + suggestions */}
      <div>
        <Input label="Group Name *" value={form.name ?? ''} required placeholder="e.g. Apex, Velocity…"
          onChange={(e: any) => sf('name', typeof e === 'string' ? e : e.target?.value ?? '')} />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTED_GROUP_NAMES.slice(0, 10).map(n => (
            <button key={n} onClick={() => sf('name', n)}
              className="px-2.5 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500
                hover:bg-violet-100 hover:text-violet-700 transition-colors">
              {n}
            </button>
          ))}
        </div>
      </div>

      <FormGrid cols={2}>
        {/* Region — clears state_id when changed */}
        <SearchableSelect
          label="Region"
          options={regions}
          value={form.region_id ?? null}
          onChange={v => setForm({ ...form, region_id: v, state_id: null })}
          placeholder="Select region…"
          clearable
        />
        {/* State — SearchableSelect filtered by region */}
        <SearchableSelect
          label="State"
          options={filteredStates}
          value={form.state_id ?? null}
          onChange={v => sf('state_id', v)}
          placeholder={form.region_id ? 'Select state…' : 'Select region first'}
          clearable
          hint={form.region_id ? 'Filtered by selected region' : 'Select a region to filter states'}
        />
      </FormGrid>

      <SearchableSelect
        label="Group Manager"
        options={managers}
        value={form.manager_id ?? null}
        onChange={v => sf('manager_id', v)}
        placeholder="Select manager…"
        clearable
        hint="One manager per group"
      />

      <Input label="Description" value={form.description ?? ''}
        onChange={(e: any) => sf('description', typeof e === 'string' ? e : e.target?.value ?? '')} />

      {/* Icon picker */}
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Icon</p>
        <div className="flex gap-2 flex-wrap">
          {GROUP_ICONS.map(({ key, icon, label }) => (
            <button key={key} title={label} onClick={() => sf('icon', key)}
              className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all border-2
                ${form.icon === key
                  ? `${colorBg} text-white border-transparent shadow-md scale-110`
                  : 'bg-gray-50 text-gray-400 border-gray-100 hover:border-gray-300'}`}>
              {icon}
            </button>
          ))}
        </div>
      </div>

      {/* Color picker */}
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Color</p>
        <div className="flex gap-2 flex-wrap">
          {GROUP_COLORS.map(({ key, bg }) => (
            <button key={key} onClick={() => sf('color', key)}
              className={`w-7 h-7 rounded-full ${bg} transition-all border-2
                ${form.color === key ? 'border-gray-700 scale-110 shadow-md' : 'border-transparent'}`} />
          ))}
        </div>
      </div>
    </div>
  )
}

function SimpleFormBody({ fields, form, setForm }: {
  fields: string[]; form: Record<string, any>; setForm: (f: Record<string, any>) => void
}) {
  const sf = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value })
  return (
    <div className="space-y-4">
      {fields.map(f => (
        <Input key={f} label={FIELD_LABELS[f] || f} value={form[f] ?? ''} onChange={sf(f)} required={f === 'name'} />
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
  return (
    <div className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors group">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className={`w-9 h-9 rounded-xl ${getColorBg(item.color ?? 'violet')} flex items-center justify-center text-white flex-shrink-0`}>
          {getIconComponent(item.icon ?? 'zap', 16)}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-gray-900">{item.name}</p>
            {item.region_name && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-100 text-sky-700 border border-sky-200">
                <MapPin size={9} />{item.region_name}
              </span>
            )}
            {/* changed: was item.state (string), now item.state_name (from FK) */}
            {item.state_name && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 border border-emerald-200">
                {item.state_name}
              </span>
            )}
          </div>
          <div className="flex gap-3 mt-0.5 flex-wrap">
            {item.manager_name  && <span className="text-xs text-purple-600 font-medium">👤 {item.manager_name}</span>}
            {item.sales_count != null && <span className="text-xs text-emerald-600 font-medium">🧑‍💼 {item.sales_count} sales</span>}
            {item.description   && <span className="text-xs text-gray-400">{item.description}</span>}
          </div>
        </div>
      </div>
      <RowActions onEdit={onEdit} onDelete={onDelete} />
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
          {item.name?.[0]?.toUpperCase() ?? '?'}
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
  const [activeTab, setActiveTab]           = useState('lead-sources')
  const [data, setData]                     = useState<any[]>([])
  const [loading, setLoading]               = useState(true)
  const [drawerOpen, setDrawerOpen]         = useState(false)
  const [editId, setEditId]                 = useState<number | null>(null)
  const [form, setForm]                     = useState<Record<string, any>>({})
  const [saving, setSaving]                 = useState(false)
  const [search, setSearch]                 = useState('')
  const [products, setProducts]             = useState<{ value: number; label: string }[]>([])
  const [regions, setRegions]               = useState<{ value: number; label: string }[]>([])
  const [states, setStates]                 = useState<{ value: number; label: string; region_id?: number }[]>([])
  const [leadCategories, setLeadCategories] = useState<{ value: number; label: string }[]>([])
  const [managers, setManagers]             = useState<{ value: number; label: string; subtitle?: string }[]>([])
  const { success, error: showError }       = useToast()

  const tab          = TABS.find(t => t.key === activeTab)!
  const isOEM        = activeTab === 'oems'
  const isRegion     = activeTab === 'regions'
  const isState      = activeTab === 'states'
  const isGroup      = activeTab === 'groups'
  const isLeadSubCat = activeTab === 'lead-sub-categories'
  const singular     = tab.label.endsWith('ies')
    ? tab.label.slice(0, -3) + 'y'
    : tab.label.endsWith('s') ? tab.label.slice(0, -1) : tab.label

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
    api.get('/masters/users-for-select?roles=manager,vp')
      .then(r => setManagers((r.data as any[]).map(x => ({ value: x.id, label: x.label, subtitle: x.subtitle }))))
      .catch(() => {})
  }, [])

  const load = async () => {
    setLoading(true)
    try   { const r = await api.get(tab.endpoint); setData(r.data) }
    catch { showError('Failed to load') }
    finally { setLoading(false) }
  }

  useEffect(() => {
    load(); setDrawerOpen(false); setForm({}); setEditId(null); setSearch('')
  }, [activeTab])

  // Keep region/category selects in sync when their tab data reloads
  useEffect(() => {
    if (activeTab === 'regions')         setRegions(data.map((x: any) => ({ value: x.id, label: x.name })))
    if (activeTab === 'states')          setStates(data.map((x: any) => ({ value: x.id, label: x.name, region_id: x.region_id ?? null })))
    if (activeTab === 'lead-categories') setLeadCategories(data.map((x: any) => ({ value: x.id, label: x.name })))
  }, [data])

  const handleSave = async () => {
    if (!form.name?.trim())                       { showError('Name is required'); return }
    if (isLeadSubCat && !form.category_id)        { showError('Lead Category is required'); return }
    setSaving(true)
    try {
      if (editId) { await api.put(`${tab.endpoint}/${editId}`, form); success('Updated successfully') }
      else        { await api.post(tab.endpoint, form);               success('Created successfully') }
      setDrawerOpen(false); setForm({}); setEditId(null); load()
    } catch (e: any) {
      showError(e.response?.data?.detail || 'Save failed')
    } finally { setSaving(false) }
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this item?')) return
    try   { await api.delete(`${tab.endpoint}/${id}`); success('Deleted'); load() }
    catch (e: any) { showError(e.response?.data?.detail || 'Failed to delete') }
  }

  const startEdit = (item: any) => {
    setEditId(item.id)
    const f: Record<string, any> = {}
    tab.fields.forEach(k => { f[k] = item[k] ?? '' })
    if (isOEM)        { f.product_id  = item.product_id  ?? null }
    if (isState)      { f.region_id   = item.region_id   ?? null }
    if (isLeadSubCat) { f.category_id = item.category_id ?? null }
    if (isGroup) {
      f.region_id  = item.region_id  ?? null
      f.state_id   = item.state_id   ?? null   // changed: was f.state = item.state ?? ''
      f.manager_id = item.manager_id ?? null
      f.icon       = item.icon       ?? 'zap'
      f.color      = item.color      ?? 'violet'
    }
    setForm(f); setDrawerOpen(true)
  }

  const openAdd = () => {
    setEditId(null)
    setForm(isGroup ? { icon: 'zap', color: 'violet' } : {})
    setDrawerOpen(true)
  }

  const closeDrawer = () => { setDrawerOpen(false); setForm({}); setEditId(null) }

  const drawerTitle = `${editId ? 'Edit' : 'Add'} ${singular}`
  const formBody = isOEM        ? <OEMFormBody       form={form} setForm={setForm} products={products} />
                 : isState      ? <StateFormBody      form={form} setForm={setForm} regions={regions} />
                 : isLeadSubCat ? <LeadSubCatFormBody form={form} setForm={setForm} leadCategories={leadCategories} />
                 : isGroup      ? <GroupFormBody      form={form} setForm={setForm} regions={regions} managers={managers} states={states} />
                 : isRegion     ? <SimpleFormBody     fields={['name', 'description']} form={form} setForm={setForm} />
                 :                <SimpleFormBody     fields={tab.fields} form={form} setForm={setForm} />

  return (
    <div className="p-6">
      <PageHeader title="Masters" subtitle="Manage all lookup data used across the CRM" breadcrumb={['Settings', 'Masters']} actions={<button onClick={load} className="p-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>} />

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all
              ${activeTab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

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
              const props = { key: item.id, item, onEdit: () => startEdit(item), onDelete: () => handleDelete(item.id) }
              if (isRegion)     return <RegionRow          {...props} />
              if (isState)      return <StateRow           {...props} />
              if (isGroup)      return <GroupRow           {...props} />
              if (isLeadSubCat) return <LeadSubCategoryRow {...props} />
              return <GenericRow {...props} fields={tab.fields} />
            })}
          </div>
        )}
      </Card>

      {/* Side Drawer */}
      <Drawer open={drawerOpen} title={drawerTitle} onClose={closeDrawer}>
        {formBody}
        <DrawerFooter onSave={handleSave} onCancel={closeDrawer} saving={saving} editId={editId} />
      </Drawer>
    </div>
  )
}
