import { useEffect, useState } from 'react'
import { Card, CardHeader } from '@/components/ui/Card'
import { platformApi, type HierarchyGroupRow, type ParentVisibility } from '@/services/platformApi'
import { VISIBILITY_LABEL } from './bw'

export type TenantHierarchyChoice = {
  mode: 'standalone' | 'company'
  parent_group_id: number | null
  parent_visibility: ParentVisibility
  shared_masters: boolean
  inherit_parent_policies: boolean
  industry: string
}

export const initialHierarchy = (groupId: number | null): TenantHierarchyChoice => ({
  mode: groupId ? 'company' : 'standalone', parent_group_id: groupId, parent_visibility: 'full', shared_masters: true, inherit_parent_policies: true, industry: '',
})

/** Onboarding step 2 from the prototype wizard: standalone tenant or company under a parent group. */
export default function TenantHierarchyCard({ value, onChange }: { value: TenantHierarchyChoice; onChange: (v: TenantHierarchyChoice) => void }) {
  const [groups, setGroups] = useState<HierarchyGroupRow[]>([])
  useEffect(() => {
    platformApi.tenantHierarchy().then(({ data }) => {
      setGroups(data.groups)
      const preset = data.groups.find(g => g.id === value.parent_group_id)
      if (preset) onChange({ ...value, parent_visibility: preset.default_visibility, industry: value.industry || preset.industry || '' })
    }).catch(() => undefined)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const set = <K extends keyof TenantHierarchyChoice>(key: K, v: TenantHierarchyChoice[K]) => onChange({ ...value, [key]: v })
  const option = (mode: TenantHierarchyChoice['mode'], title: string, text: string) => (
    <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${value.mode === mode ? 'border-blue-500 bg-blue-50/40' : 'border-slate-200'}`}>
      <input type="radio" name="tenant-hierarchy" checked={value.mode === mode} onChange={() => onChange({ ...value, mode, parent_group_id: mode === 'standalone' ? null : value.parent_group_id ?? groups[0]?.id ?? null })} />
      <span><span className="block font-semibold text-slate-900">{title}</span><span className="text-sm text-slate-500">{text}</span></span>
    </label>
  )
  return <Card>
    <CardHeader title="Hierarchy" subtitle="Standalone company or a company under a parent group." />
    <div className="card-body space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        {option('standalone', 'Standalone tenant', 'Independent company, no parent.')}
        {option('company', 'Company under a parent group', 'Appears in the parent’s consolidated view.')}
      </div>
      {value.mode === 'company' && (groups.length === 0
        ? <p className="text-sm text-amber-700">No parent groups exist yet. Create one from Tenants &amp; Hierarchy first.</p>
        : <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm"><span className="mb-1 block font-medium text-slate-700">Parent group</span>
            <select className="form-control" value={value.parent_group_id ?? ''} onChange={e => { const g = groups.find(x => x.id === Number(e.target.value)); onChange({ ...value, parent_group_id: Number(e.target.value), parent_visibility: g?.default_visibility ?? value.parent_visibility }) }}>
              <option value="" disabled>— Select —</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select></label>
          <label className="block text-sm"><span className="mb-1 block font-medium text-slate-700">Parent visibility</span>
            <select className="form-control" value={value.parent_visibility} onChange={e => set('parent_visibility', e.target.value as ParentVisibility)}>
              {(Object.keys(VISIBILITY_LABEL) as ParentVisibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
            </select></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.inherit_parent_policies} onChange={e => set('inherit_parent_policies', e.target.checked)} /> Inherit parent’s masters, roles and approval policy</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.shared_masters} onChange={e => set('shared_masters', e.target.checked)} /> Share master data with the group</label>
        </div>)}
      <label className="block max-w-md text-sm"><span className="mb-1 block font-medium text-slate-700">Industry</span>
        <input className="form-control" value={value.industry} onChange={e => set('industry', e.target.value)} placeholder="e.g. Power T&D, EPC & Civil" /></label>
    </div>
  </Card>
}
