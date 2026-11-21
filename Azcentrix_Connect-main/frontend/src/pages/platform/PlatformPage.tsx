import { useState, useEffect } from 'react'
import { Globe, Plus, CheckCircle, XCircle, Building2, Users, Database } from 'lucide-react'
import api from '@/services/api'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import DataTable from '@/components/ui/DataTable'
import SlidePanel from '@/components/ui/SlidePanel'
import Input from '@/components/ui/Input'
import { StatusBadge, PageHeader, StatCard, useToast, FormSection, FormGrid } from '@/components/ui/FormComponents'
import SearchableSelect from '@/components/ui/SearchableSelect'

const PLANS = ['starter', 'professional', 'enterprise']
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'UTC', 'America/New_York', 'Europe/London']

export default function PlatformPage() {
  const [tenants, setTenants] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const { success, error: showError } = useToast()
  const [form, setForm] = useState<any>({
    company_name: '', slug: '', contact_email: '', contact_phone: '',
    plan: 'professional', timezone: 'Asia/Kolkata', currency: 'INR',
    admin_name: '', admin_username: '', admin_email: '', admin_password: ''
  })

  const load = async () => {
    setLoading(true)
    try {
      const r = await api.get('/platform/tenants')
      setTenants(r.data)
    } catch { showError('Failed to load tenants') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const handleSave = async () => {
    const req = ['company_name', 'slug', 'admin_username', 'admin_email', 'admin_password']
    if (req.some(k => !form[k])) { showError('All required fields must be filled'); return }
    setSaving(true)
    try {
      await api.post('/platform/tenants', form)
      success('Tenant created and database provisioned'); setPanelOpen(false); load()
    } catch (e: any) { showError(e.response?.data?.detail || 'Failed to create tenant') }
    finally { setSaving(false) }
  }

  const toggleTenant = async (id: number, active: boolean) => {
    try {
      await api.patch(`/platform/tenants/${id}`, { is_active: !active })
      success(`Tenant ${active ? 'suspended' : 'activated'}`); load()
    } catch { showError('Failed') }
  }

  const setF = (k: string, v: any) => setForm((p: any) => ({ ...p, [k]: v }))

  const columns = [
    {
      key: 'company_name', label: 'Company', render: (v: string, row: any) => (
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
            {v?.[0]?.toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900">{v}</p>
            <p className="text-xs text-gray-400 font-mono">{row.slug}</p>
          </div>
        </div>
      )
    },
    {
      key: 'plan', label: 'Plan', render: (v: string) => (
        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold capitalize
        ${v === 'enterprise' ? 'bg-purple-100 text-purple-700' : v === 'professional' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{v}</span>
      )
    },
    { key: 'contact_email', label: 'Contact Email' },
    { key: 'user_count', label: 'Users', render: (v: number) => <span className="font-bold">{v || 0}</span> },
    { key: 'is_active', label: 'Status', render: (v: boolean) => <StatusBadge status={v ? 'Active' : 'Suspended'} /> },
    { key: 'created_at', label: 'Created', render: (v: string) => v ? new Date(v).toLocaleDateString('en-IN') : '—' },
    {
      key: 'id', label: '', render: (_: any, row: any) => (
        <div className="flex gap-1">
          <button onClick={() => toggleTenant(row.id, row.is_active)}
            className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-all
            ${row.is_active ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}>
            {row.is_active ? 'Suspend' : 'Activate'}
          </button>
        </div>
      )
    },
  ]

  const stats = {
    total: tenants.length,
    active: tenants.filter(t => t.is_active).length,
    enterprise: tenants.filter(t => t.plan === 'enterprise').length,
    totalUsers: tenants.reduce((s: number, t: any) => s + (t.user_count || 0), 0),
  }

  return (
    <div>
      <PageHeader title="Platform Administration" subtitle="Manage tenant organizations, plans and provisioning"
        breadcrumb={['Platform']}
        actions={<Button leftIcon={<Plus size={16} />} onClick={() => setPanelOpen(true)}>New Tenant</Button>}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Total Tenants" value={stats.total} icon={<Building2 size={20} />} color="blue" />
        <StatCard title="Active" value={stats.active} icon={<CheckCircle size={20} />} color="green" />
        <StatCard title="Enterprise" value={stats.enterprise} icon={<Globe size={20} />} color="purple" />
        <StatCard title="Total Users" value={stats.totalUsers} icon={<Users size={20} />} color="indigo" />
      </div>

      <Card>
        <DataTable columns={columns as any} data={tenants} loading={loading} searchable searchPlaceholder="Search tenants..." />
      </Card>

      <SlidePanel open={panelOpen} onClose={() => setPanelOpen(false)}
        title="Provision New Tenant" subtitle="Creates a new tenant with isolated database"
        footer={<>
          <Button variant="outline" onClick={() => setPanelOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>Provision Tenant</Button>
        </>}
      >
        <FormSection title="Organisation">
          <FormGrid cols={2}>
            <div className="col-span-2">
              <Input label="Company Name" required value={form.company_name} onChange={v => setF('company_name', v)} />
            </div>
            <Input label="Tenant Slug" required value={form.slug} onChange={e => setF('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              hint="Unique identifier — e.g. acme-corp" />
            <SearchableSelect label="Plan" options={PLANS.map(p => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }))} value={form.plan} onChange={v => setF('plan', v)} />
            <Input label="Contact Email" type="email" value={form.contact_email} onChange={v => setF('contact_email', v)} />
            <Input label="Contact Phone" value={form.contact_phone} onChange={v => setF('contact_phone', v)} />
            <SearchableSelect label="Timezone" options={TIMEZONES.map(t => ({ value: t, label: t }))} value={form.timezone} onChange={v => setF('timezone', v)} />
            <SearchableSelect label="Currency" options={[{ value: 'INR', label: 'INR — Indian Rupee' }, { value: 'USD', label: 'USD — US Dollar' }, { value: 'AED', label: 'AED — UAE Dirham' }]} value={form.currency} onChange={v => setF('currency', v)} />
          </FormGrid>
        </FormSection>
        <FormSection title="Admin User" subtitle="Will be created in the new tenant's database">
          <FormGrid cols={2}>
            <Input label="Full Name" value={form.admin_name} onChange={v => setF('admin_name', v)} />
            <Input label="Username" required value={form.admin_username} onChange={e => setF('admin_username', e.target.value.toLowerCase())} />
            <Input label="Email" required type="email" value={form.admin_email} onChange={v => setF('admin_email', v)} />
            <Input label="Password" required type="password" value={form.admin_password} onChange={v => setF('admin_password', v)} hint="Min 8 chars" />
          </FormGrid>
        </FormSection>
        <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-xl border border-blue-100">
          <Database size={18} className="text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-blue-800">Isolated Database Provisioning</p>
            <p className="text-xs text-blue-600 mt-0.5">A dedicated MySQL database will be created for this tenant with all required tables and seed data.</p>
          </div>
        </div>
      </SlidePanel>
    </div>
  )
}
