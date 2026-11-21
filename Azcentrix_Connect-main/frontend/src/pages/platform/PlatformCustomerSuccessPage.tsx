import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { platformApi, type CsFactor, type CsOverview, type CsRow, type Paged } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol, type GridServer } from '@/components/platform/BwGrid'
import { Bar, Btn, C, Empty, Ic, Note, Panel, Pill, Strip, Switch, errMsg, fd, inr, num } from '@/components/platform/bw'
import { Heat } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout follows the Bidwise prototype v7 Customer success page (P.success): five KPIs, Tenant health grid + Health model,
// Feature adoption heat-map + Playbooks. Every figure is measured; a factor with no data shows "—" with the reason, and a
// tenant whose measured factors carry too little weight is "Not scored" rather than given a misleading health.
const RISK_TONE = { High: 'ba', Medium: 'wa', Low: 'ok' } as const
const healthTone = (h: number) => h < 65 ? C.ba : h < 78 ? C.wa : C.ok

function FactorCell({ r, k }: { r: CsRow; k: CsFactor }) {
  const v = r.factors[k]
  return <span title={r.notes[k]} style={{ color: v == null ? C.mu : undefined }}>{v == null ? '—' : v}</span>
}

export default function PlatformCustomerSuccessPage() {
  const { can } = usePlatformAccess()
  const navigate = useNavigate()
  const { success, info, warning, error: showError } = useToast()
  const [data, setData] = useState<CsOverview | null>(null)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Paged<CsRow>>({ items: [], total: 0, offset: 0, limit: 25 })
  const [query, setQuery] = useState({ q: '', sort: '', offset: 0, limit: 25 })
  const [running, setRunning] = useState(false)
  const load = useCallback(async () => {
    try { const { data: next } = await platformApi.customerSuccess(); setData(next); setError('') } catch (err) { setError(errMsg(err, 'Customer success unavailable')) }
  }, [])
  const loadRows = useCallback(async () => {
    try { const { data: next } = await platformApi.customerSuccessTenants(query.q, query.sort, query.offset, query.limit); setRows(next) }
    catch (err) { showError(errMsg(err, 'Unable to load tenant health')) }
  }, [query, showError])
  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadRows() }, [loadRows])
  const canManage = can('tenants', 'manage')
  const canPlatform = canManage && !!data?.all_scope

  const runPlaybook = async () => {
    setRunning(true)
    try {
      const { data: r } = await platformApi.customerSuccessRun()
      const parts = [`${r.matched} match(es)`, `${r.done} action(s) done`]
      if (r.already_done) parts.push(`${r.already_done} already done`)
      if (r.failed) parts.push(`${r.failed} failed`)
      if (r.not_sent) parts.push(`${r.not_sent} e-mail(s) not sent – playbook e-mail is off`)
      const msg = parts.join(' · ')
      if (r.outcome === 'no_matches') info('Playbook run complete', `No tenant matches an enabled playbook (${r.tenants} checked)`)
      else if (r.outcome === 'success') success('Playbook run complete', msg)
      else if (r.outcome === 'partial') warning('Playbook run partly completed', msg)
      else showError('Playbook run failed', msg)
      await Promise.all([load(), loadRows()])
    } catch (err) { showError(errMsg(err, 'Playbook run failed')) } finally { setRunning(false) }
  }
  const setPlaybook = async (key: string, enabled: boolean) => {
    try { await platformApi.customerSuccessPlaybook(key, enabled); success('Playbook saved'); await load() } catch (err) { showError(errMsg(err, 'Unable to save the playbook')) }
  }

  const cols: GridCol<CsRow>[] = [
    { k: 't', t: 'Tenant', w: 220, txt: r => r.name, fn: r => <Link to={`/platform/tenants/${r.id}`} onClick={e => e.stopPropagation()} style={{ color: C.ac }}><b>{r.name}</b></Link> },
    { k: 'h', t: 'Health', w: 130, sv: r => r.health, txt: r => r.health == null ? 'Not scored' : String(r.health),
      fn: r => r.health == null ? <span title={`Not scored – measured factors cover under ${data?.min_weight ?? 55}% of the model. Missing: ${r.missing.join(', ')}`} style={{ color: C.mu }}>Not scored</span>
        : <span title={r.missing.length ? `Missing (left out, rest re-weighted): ${r.missing.join(', ')}` : undefined}><Bar value={r.health} tone={healthTone(r.health)} /></span> },
    { k: 'u', t: 'Usage', r: true, sv: r => r.factors.usage, txt: r => r.factors.usage == null ? '—' : String(r.factors.usage), fn: r => <FactorCell r={r} k="usage" /> },
    { k: 'a', t: 'Adoption', r: true, sv: r => r.factors.adoption, txt: r => r.factors.adoption == null ? '—' : String(r.factors.adoption), fn: r => <FactorCell r={r} k="adoption" /> },
    { k: 'sp', t: 'Support', r: true, sv: r => r.factors.support, txt: r => r.factors.support == null ? '—' : String(r.factors.support), fn: r => <FactorCell r={r} k="support" /> },
    { k: 'n', t: 'NPS', r: true, sv: r => r.factors.nps, txt: r => r.factors.nps == null ? '—' : String(r.factors.nps), fn: r => <FactorCell r={r} k="nps" /> },
    { k: 'arr', t: 'ARR', r: true, money: true, sum: true, sv: r => r.arr, sumv: r => r.arr, sumFmt: inr, txt: r => inr(r.arr) },
    { k: 'ren', t: 'Renewal', sv: r => r.renewal, txt: r => fd(r.renewal), fn: r => r.renewal ? <span title={r.renewal_kind === 'trial ends' ? 'Trial ends' : 'Subscription renewal'}>{fd(r.renewal)}</span> : <span style={{ color: C.mu }}>—</span> },
    { k: 'risk', t: 'Churn risk', txt: r => r.risk ?? 'Not scored', fn: r => r.risk ? <Pill t={RISK_TONE[r.risk]}>{r.risk}</Pill> : <Pill t="mu">Not scored</Pill> },
  ]
  const server: GridServer = {
    total: rows.total,
    onChange: useCallback(s => {
      const sort = s.sorts.map(([k, d]) => `${k}:${d}`).join(',')
      setQuery(x => x.offset === s.offset && x.limit === s.limit && x.sort === sort ? x : { ...x, offset: s.offset, limit: s.limit, sort })
    }, []),
  }
  const onQuery = useCallback((s: { q: string }) => setQuery(x => x.q === s.q ? x : { ...x, q: s.q, offset: 0 }), [])
  const k = data?.kpis

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    <div className="mb-2 flex flex-wrap items-end gap-2">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Business</div><h1 className="text-xl font-semibold">Customer success</h1></div>
      <span className="flex-1" />
      <Btn disabled={!canManage || running || !data} title={canManage ? 'Evaluate the switched-on playbooks and run their actions once per tenant' : 'Needs Tenants manage access'} onClick={() => void runPlaybook()}>
        <Ic n="git" /> {running ? 'Running…' : 'Run playbook'}</Btn>
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}
    {k && <Strip items={[
      { l: 'Avg health', v: k.avg_health ?? '—', d: k.scored < k.tenants ? `${k.tenants - k.scored} not scored` : undefined, kpi: 'cs.avg_health' },
      { l: 'At-risk tenants', v: <span style={{ color: k.at_risk ? C.ba : undefined }}>{num(k.at_risk)}</span>, kpi: 'cs.at_risk' },
      { l: 'ARR at risk', v: <span style={{ color: k.arr_at_risk ? C.wa : undefined }}>{inr(k.arr_at_risk)}</span>, kpi: 'cs.arr_at_risk' },
      { l: 'Net promoter score', v: k.nps ?? '—', d: k.nps == null ? 'no survey data' : undefined, kpi: 'cs.nps' },
      { l: 'Renewals · 90 days', v: num(k.renewals_90d), d: k.renewals_trial ? `incl. ${k.renewals_trial} trial end${k.renewals_trial === 1 ? '' : 's'}` : undefined, kpi: 'cs.renewals' },
    ]} />}
    <div className="mb-2 grid gap-2 lg:grid-cols-[2fr_1fr]">
      <Panel title="Tenant health" flush>
        <BwGrid id="cs-health" cols={cols} rows={rows.items} rid={r => String(r.id)} onRow={r => navigate(`/platform/tenants/${r.id}`)} server={server} onQuery={onQuery} empty="No tenants in your scope." />
      </Panel>
      <Panel title="Health model">
        {data ? <div className="grid gap-2">{data.model.map(m => <div key={m.key} className="flex items-center gap-2"><span className="flex-1">{m.label}</span><b>{m.weight}%</b></div>)}</div>
          : <Empty>{error || 'Loading…'}</Empty>}
      </Panel>
    </div>
    <div className="grid gap-2 lg:grid-cols-2">
      <Panel title="Feature adoption heat-map">
        {!data ? <Empty>{error || 'Loading…'}</Empty> : !rows.items.length ? <Empty>No tenants in your scope.</Empty>
          : <Heat rows={rows.items.map(r => r.name)} cols={data.modules} cell={(i, j) => {
            const r = rows.items[i], a = r.adoption[data.modules[j]]
            return { v: a?.pct ?? null, t: `${r.name} · ${data.modules[j]}: ${a?.pct != null ? `${a.pct}% – ${a.note}` : a?.note ?? 'unavailable'}` }
          }} />}
      </Panel>
      <Panel title="Playbooks">
        {data ? <div className="grid gap-2">{data.playbooks.map(p => <div key={p.key} className="flex items-start gap-2">
          <span className="mt-0.5"><Switch on={p.enabled} label={p.title} disabled={!canPlatform} onChange={v => void setPlaybook(p.key, v)} /></span>
          <span className="flex-1"><b>{p.title}</b><br /><small style={{ color: C.mu }}>{p.actions}</small></span></div>)}</div>
          : <Empty>{error || 'Loading…'}</Empty>}
      </Panel>
    </div>
  </div>
}
