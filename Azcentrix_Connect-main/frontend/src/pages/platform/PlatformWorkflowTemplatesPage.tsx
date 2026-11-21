import { useCallback, useEffect, useState } from 'react'
import { platformApi, type WorkflowStage, type WorkflowTemplate, type WorkflowTenantOption } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Note, Panel, Pill, errMsg, inputCls, inputStyle } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype Workflow templates page (P.templates / pushTpl): one panel per template with its
// open stages (⚑ marks an approval or checklist gate), the tenants using it, and a Push to tenant… modal.
const MORE = '__more'

const stageTitle = (s: WorkflowStage) => [
  `${s.name} · SLA ${s.sla_days} day${s.sla_days === 1 ? '' : 's'}`,
  s.gate !== 'None' ? `${s.gate} gate${s.owner_role ? ` (${s.owner_role})` : ''}` : s.owner_role ? `Owner: ${s.owner_role}` : '',
  s.checklist.length ? `Checklist: ${s.checklist.join(', ')}` : '',
].filter(Boolean).join('\n')

function PushModal({ template, onClose, onPushed }: { template: WorkflowTemplate; onClose: () => void; onPushed: () => void }) {
  const { success, error: showError } = useToast()
  const [tenants, setTenants] = useState<WorkflowTenantOption[]>([])
  const [total, setTotal] = useState(0)
  const [target, setTarget] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)

  const loadPage = useCallback(async (offset: number) => {
    setLoading(true)
    try {
      const { data } = await platformApi.workflowTemplateTenants(offset)
      setTenants(prev => offset ? [...prev, ...data.items] : data.items)
      setTotal(data.total)
      if (!offset && data.items.length) setTarget(String(data.items[0].id))
      setLoadError('')
    } catch (err) { setLoadError(errMsg(err, 'Tenants unavailable')) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void loadPage(0) }, [loadPage])

  const push = async () => {
    setBusy(true)
    try {
      const { data: r } = await platformApi.pushTemplateToTenant(template.id, Number(target))
      success(`Template applied to ${r.tenant.name}`, r.records ? `${r.records} tender${r.records === 1 ? '' : 's'} mapped · ${r.records_moved} moved to the nearest stage` : undefined)
      onPushed()
    } catch (err) { showError(errMsg(err, 'Unable to push the template')) } finally { setBusy(false) }
  }

  return <BwModal title={`Push “${template.name}”`} width={440} onClose={onClose} foot={<>
    <Btn onClick={onClose}>Cancel</Btn>
    <Btn p disabled={busy || loading || !target} onClick={() => void push()}>{busy ? 'Pushing…' : 'Push template'}</Btn>
  </>}>
    <label className="mb-0.5 block text-xs" style={{ color: C.mu }} htmlFor="pt">Target tenant</label>
    <select id="pt" className={`${inputCls} mb-2`} style={inputStyle} value={target} disabled={busy || (!tenants.length && loading)}
      onChange={e => { if (e.target.value === MORE) void loadPage(tenants.length); else setTarget(e.target.value) }}>
      {!tenants.length && <option value="">{loading ? 'Loading…' : loadError || 'No tenants available'}</option>}
      {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      {tenants.length < total && <option value={MORE}>{loading ? 'Loading…' : `Load more tenants (${total - tenants.length})…`}</option>}
    </select>
    {loadError && !!tenants.length && <Note className="mb-2">{loadError}</Note>}
    <Note>Records in removed stages are moved to the nearest stage by position.</Note>
  </BwModal>
}

type Draft = { name: string; sla_days: string; gate: WorkflowStage['gate']; owner_role: string; checklist: string }
const draftOf = (s?: WorkflowStage): Draft => ({ name: s?.name ?? '', sla_days: String(s?.sla_days ?? 0), gate: s?.gate ?? 'None', owner_role: s?.owner_role ?? '', checklist: (s?.checklist ?? []).join('; ') })

// New template: open stages (start blank or from an existing template); the Won / Lost outcomes are added by the server.
function NewTemplateModal({ templates, onClose, onCreated }: { templates: WorkflowTemplate[]; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast()
  const [name, setName] = useState('')
  const [stages, setStages] = useState<Draft[]>([draftOf()])
  const [busy, setBusy] = useState(false)
  const set = (i: number, patch: Partial<Draft>) => setStages(xs => xs.map((x, j) => j === i ? { ...x, ...patch } : x))
  const save = async () => {
    if (!name.trim()) return showError('Enter a template name')
    setBusy(true)
    try {
      await platformApi.createWorkflowTemplate({ name: name.trim(), stages: stages.map(s => ({ name: s.name.trim(), sla_days: Number(s.sla_days) || 0, gate: s.gate, owner_role: s.owner_role.trim() || null, checklist: s.checklist.split(';').map(c => c.trim()).filter(Boolean) })) })
      success(`Template “${name.trim()}” created`); onCreated()
    } catch (err) { showError(errMsg(err, 'Unable to create the template')) } finally { setBusy(false) }
  }
  return <BwModal title="New workflow template" width={720} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy} onClick={() => void save()}>{busy ? 'Creating…' : 'Create template'}</Btn></>}>
    <div className="mb-2 grid gap-2 sm:grid-cols-2">
      <div><label className="mb-0.5 block text-xs" style={{ color: C.mu }} htmlFor="tn">Template name</label><input id="tn" className={inputCls} style={inputStyle} value={name} maxLength={150} onChange={e => setName(e.target.value)} autoFocus /></div>
      <div><label className="mb-0.5 block text-xs" style={{ color: C.mu }} htmlFor="tf">Start from</label><select id="tf" className={inputCls} style={inputStyle} defaultValue="" onChange={e => { const t = templates.find(x => String(x.id) === e.target.value); setStages(t ? t.stages.filter(s => s.kind === 'open').map(draftOf) : [draftOf()]) }}>
        <option value="">Blank</option>{templates.map(t => <option key={t.id} value={t.id}>Copy stages of {t.name}</option>)}</select></div>
    </div>
    <div className="max-h-[50vh] overflow-auto"><table className="w-full text-left"><thead><tr><th>Stage</th><th className="w-[70px]">SLA days</th><th className="w-[110px]">Gate</th><th>Owner role</th><th>Checklist (; separated)</th><th /></tr></thead>
      <tbody>{stages.map((s, i) => <tr key={i}>
        <td><input aria-label="Stage name" className={inputCls} style={inputStyle} value={s.name} maxLength={150} onChange={e => set(i, { name: e.target.value })} /></td>
        <td><input aria-label="SLA days" type="number" min={0} max={365} className={inputCls} style={inputStyle} value={s.sla_days} onChange={e => set(i, { sla_days: e.target.value })} /></td>
        <td><select aria-label="Gate" className={inputCls} style={inputStyle} value={s.gate} onChange={e => set(i, { gate: e.target.value as WorkflowStage['gate'] })}><option>None</option><option>Approval</option><option>Checklist</option></select></td>
        <td><input aria-label="Owner role" className={inputCls} style={inputStyle} value={s.owner_role} maxLength={100} onChange={e => set(i, { owner_role: e.target.value })} /></td>
        <td><input aria-label="Checklist" className={inputCls} style={inputStyle} value={s.checklist} disabled={s.gate !== 'Checklist'} onChange={e => set(i, { checklist: e.target.value })} /></td>
        <td className="whitespace-nowrap text-right"><Btn s disabled={!i} title="Move up" onClick={() => setStages(xs => { const n = xs.slice(); [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n })}>↑</Btn> <Btn s d disabled={stages.length < 2} title="Remove stage" onClick={() => setStages(xs => xs.filter((_, j) => j !== i))}>✕</Btn></td>
      </tr>)}</tbody></table></div>
    <div className="mt-2 flex items-center gap-2"><Btn s onClick={() => setStages(xs => [...xs, draftOf()])}>Add stage</Btn><small className="flex-1 text-xs" style={{ color: C.mu }}>Won and Lost outcomes are added after the last stage.</small></div>
  </BwModal>
}

export default function PlatformWorkflowTemplatesPage() {
  const { can } = usePlatformAccess()
  const [creating, setCreating] = useState(false)
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null)
  const [error, setError] = useState('')
  const [pushing, setPushing] = useState<WorkflowTemplate | null>(null)
  const load = useCallback(async () => {
    try { const { data } = await platformApi.workflowTemplates(); setTemplates(data.templates); setError('') }
    catch (err) { setError(errMsg(err, 'Workflow templates unavailable')) }
  }, [])
  useEffect(() => { void load() }, [load])
  const canPush = can('tenants', 'manage')

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div className="flex-1"><h1 className="text-xl font-semibold">Workflow templates</h1>
        <div style={{ color: C.mu }}>Industry-ready pipelines. Push to a tenant to replace or merge its stages.</div></div>
      <Btn p disabled={!canPush || !templates} title={canPush ? undefined : 'Creating a template needs Tenants manage permission'} onClick={() => setCreating(true)}>New template</Btn>
    </div>
    {error && <Note className="mb-2">{error}{templates ? ' · showing the last data received' : ''}</Note>}

    {!templates ? <Panel title="Workflow templates"><Empty>{error || 'Loading…'}</Empty></Panel>
      : !templates.length ? <Panel title="Workflow templates"><Empty>No workflow templates are available.</Empty></Panel>
        : <div className="grid gap-2 md:grid-cols-2">{templates.map(t => <Panel key={t.id} title={t.name}>
          <div className="mb-2 flex flex-wrap gap-[3px]">{t.stages.filter(s => s.kind === 'open').map(s =>
            <Pill key={s.position} t="mu" title={stageTitle(s)}>{s.name}{s.gate !== 'None' ? ' ⚑' : ''}</Pill>)}</div>
          <div className="flex items-center gap-2"><small className="flex-1 text-xs" style={{ color: C.mu }}>⚑ = approval or checklist gate · used by {t.tenants} tenant(s)</small>
            <Btn s disabled={!canPush} title={canPush ? undefined : 'Pushing a template needs Tenants manage permission'} onClick={() => setPushing(t)}>Push to tenant…</Btn></div>
        </Panel>)}</div>}

    {creating && templates && <NewTemplateModal templates={templates} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load() }} />}
    {pushing && <PushModal template={pushing} onClose={() => setPushing(null)} onPushed={() => { setPushing(null); void load() }} />}
  </div>
}
