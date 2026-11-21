import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { platformApi, type OnboardingPipeline } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, C, Empty, Note, Panel, Pill, Strip, Switch, errMsg, fdt } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import NewTenantModal from '@/components/platform/NewTenantModal'

// Prototype bar(v): 60px accent bar followed by the percentage.
const bar = (v: number) => <span className="inline-flex items-center"><span className="mr-[5px] inline-block h-1.5 w-[60px] overflow-hidden rounded-md align-middle" style={{ background: C.ln2 }}><i className="block h-full" style={{ width: `${Math.min(100, v)}%`, background: C.ac }} /></span>{Math.round(v)}%</span>

export default function PlatformOnboardingPage() {
  const [params, setParams] = useSearchParams()
  const { can } = usePlatformAccess()
  const canManage = can('tenants', 'manage')
  const { success, error: showError } = useToast()
  const [data, setData] = useState<OnboardingPipeline | null>(null)
  const [error, setError] = useState('')
  const [running, setRunning] = useState<number | null>(null)
  // ?new=1[&group=<id>] opens the wizard (old tenant-onboarding links redirect here)
  const [creating, setCreating] = useState(params.get('new') === '1')
  const presetGroup = Number(params.get('group')) || null

  // Only the most recent reload is applied, so a slow earlier response can't undo a newer toggle.
  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try { const { data: next } = await platformApi.onboardingPipeline(); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Unable to load the onboarding pipeline')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const runNext = async (id: number) => {
    setRunning(id)
    try { const { data: r } = await platformApi.runOnboardingStep(id); success(r.step ? 'Step completed' : r.message, r.step || undefined); await load() }
    catch (err) { showError(errMsg(err, 'Step could not be completed')) } finally { setRunning(null) }
  }


  const toggleStep = async (key: string, enabled: boolean) => {
    if (!data) return
    seq.current++
    setData(d => d && { ...d, steps: d.steps.map(s => s.key === key ? { ...s, enabled } : s) })
    try { await platformApi.setBlueprintStep(key, enabled); await load() }
    catch (err) { showError(errMsg(err, 'Unable to update the blueprint')); await load() }
  }

  const k = data?.kpis
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {creating && <NewTenantModal presetGroup={presetGroup} onClose={() => { setCreating(false); if (params.has('new')) setParams({}, { replace: true }) }} />}
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Command</div><h1 className="text-xl font-semibold">Onboarding &amp; provisioning</h1></div>
      <span className="flex-1" />
      {canManage && <Btn p onClick={() => setCreating(true)}><Plus size={14} /> New tenant</Btn>}
    </div>
    {error && <Note className="mb-2">{error}</Note>}
    <Strip items={[
      { l: 'In onboarding', v: k ? k.in_onboarding : '—', kpi: 'onboarding.in_onboarding' },
      { l: 'Avg. time to go-live', v: k?.avg_go_live_days != null ? `${k.avg_go_live_days} days` : '—', kpi: 'onboarding.go_live' },
      { l: 'Provisioning success', v: <span style={{ color: k?.provisioning_success != null && k.provisioning_success < 100 ? C.wa : C.ok }}>{k?.provisioning_success != null ? `${k.provisioning_success}%` : '—'}</span>, kpi: 'onboarding.provisioning' },
      { l: 'Stuck > 48 h', v: k ? k.stuck : '—', kpi: 'onboarding.stuck' },
    ]} />
    <div className="grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title="Tenant pipeline" flush>
        {!data ? <Empty>{error ? 'Pipeline unavailable' : 'Loading…'}</Empty> : !data.tenants.length ? <Empty>No tenants yet</Empty> : <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left">
          <thead><tr><th>Tenant</th><th>Progress</th><th>Steps</th><th>Next step</th><th /></tr></thead>
          <tbody>{data.tenants.map(t => <tr key={t.id}>
            <td><b>{t.name}</b></td>
            <td>{bar(t.total ? t.progress / t.total * 100 : 100)}</td>
            <td className="whitespace-nowrap">{t.steps.map(s => <span key={s.key} title={`${s.label}${!s.enabled ? ' · switched off in blueprint' : s.done ? ` · done ${fdt(s.completed_at)}${s.completed_by ? ` by ${s.completed_by}` : ''}${s.note ? ` · ${s.note}` : ''}` : ''}`} style={{ color: s.complete ? C.ok : C.ln, opacity: s.enabled ? 1 : 0.35 }}>●</span>)}</td>
            <td>{t.progress < t.total ? t.next_step : <Pill t="ok">Live</Pill>}</td>
            <td className="text-right">{t.progress < t.total && canManage && <Btn s disabled={running !== null} onClick={() => void runNext(t.id)}>{running === t.id ? 'Running…' : 'Run next step'}</Btn>}</td>
          </tr>)}</tbody>
        </table></div>}
      </Panel>
      <Panel title="Provisioning blueprint" flush>
        <div>{(data?.steps ?? []).map((s, i) => <div key={s.key} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }}>
          <Switch on={s.enabled} disabled={!canManage} label={s.label} onChange={v => void toggleStep(s.key, v)} /><span className="flex-1">{i + 1}. {s.label}</span><small style={{ color: C.mu }}>{s.kind}</small>
        </div>)}</div>
      </Panel>
    </div>
  </div>
}
