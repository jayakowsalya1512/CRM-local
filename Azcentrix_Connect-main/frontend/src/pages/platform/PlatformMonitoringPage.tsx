import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { platformApi, type MonitoringOverview, type MonitoringRange, type MonitoringRule } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import { Btn, BwModal, C, Empty, Field, Note, Panel, Pill, Strip, Switch, errMsg, fd, inputCls, inputStyle, num, type Tone } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import { BarChart, HBars, LineChart, PAL } from '@/components/platform/charts'

// Layout, KPI order, panels, filters and chart styles follow the Bidwise prototype Monitoring page (P.mon).
// Every figure comes from the backend: request histograms per minute, uptime probes, process and health checks.
const SERVICES = ['All services', 'API gateway', 'Web app', 'Workflow engine', 'Notification service', 'Document store', 'AI service', 'Database']
const RANGES: MonitoringRange[] = ['1h', '6h', '24h', '7d']
const LIVE_MS = 15_000
const STATUS_TONE: Record<string, Tone> = { Operational: 'ok', Degraded: 'wa', Down: 'ba', 'Not configured': 'mu' }
const ago = (m: number) => m === 0 ? 'now' : m < 60 ? `-${m}m` : m < 1440 ? `-${Math.round(m / 60)}h` : `-${Math.round(m / 1440)}d`
const pct = (v: number | null, digits = 1) => v == null ? '—' : `${Number(v.toFixed(digits))}%`

function NewRuleModal({ options, onClose, onSaved }: { options: MonitoringOverview['rule_options']; onClose: () => void; onSaved: () => Promise<void> }) {
  const { success, error: showError } = useToast()
  const [form, setForm] = useState({ metric: 'api_p95', threshold: '400', duration: '5', action: 'page_oncall', target: '', severity: 'SEV3' })
  const [busy, setBusy] = useState(false)
  const metric = options.metrics[form.metric]
  const windowed = ['api_p95', 'error_rate', 'db_cpu'].includes(form.metric)
  const actions = Object.entries(options.actions).filter(([k]) => k !== 'email_tenant_admin' || form.metric === 'tenant_storage')
  const set = (k: keyof typeof form, v: string) => setForm(f => ({ ...f, [k]: v, ...(k === 'metric' && f.action === 'email_tenant_admin' && v !== 'tenant_storage' ? { action: 'page_oncall' } : {}) }))
  const save = async () => {
    const threshold = Number(form.threshold)
    if (!(threshold > 0)) return showError('Enter a threshold above 0')
    setBusy(true)
    try {
      const { data } = await platformApi.createAlertRule({ metric: form.metric, threshold, duration_minutes: Number(form.duration) || metric.window, action: form.action, target: form.target.trim() || undefined, severity: form.severity })
      success('Alert rule created', data.label); await onSaved(); onClose()
    } catch (err) { showError(errMsg(err, 'Unable to create the alert rule')) } finally { setBusy(false) }
  }
  return <BwModal title="New alert rule" width={520} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Create rule'}</Btn></>}>
    <div className="grid gap-2.5 sm:grid-cols-2">
      <Field label="Metric"><select className={inputCls} style={inputStyle} value={form.metric} onChange={e => set('metric', e.target.value)}>{Object.entries(options.metrics).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</select></Field>
      <Field label={`Threshold (above${metric.unit ? `, ${metric.unit}` : ''})`}><input type="number" min={0} step="any" className={inputCls} style={inputStyle} value={form.threshold} onChange={e => set('threshold', e.target.value)} /></Field>
      {windowed && <Field label="For (minutes)"><input type="number" min={1} max={1440} className={inputCls} style={inputStyle} value={form.duration} onChange={e => set('duration', e.target.value)} /></Field>}
      <Field label="Severity"><select className={inputCls} style={inputStyle} value={form.severity} onChange={e => set('severity', e.target.value)}>{['SEV1', 'SEV2', 'SEV3'].map(s => <option key={s}>{s}</option>)}</select></Field>
      <Field label="Action"><select className={inputCls} style={inputStyle} value={form.action} onChange={e => set('action', e.target.value)}>{actions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      {(form.action === 'slack' || form.action === 'email') && <Field label={form.action === 'slack' ? 'Slack incoming-webhook URL' : 'E-mail addresses (comma separated)'}>
        <input className={inputCls} style={inputStyle} value={form.target} onChange={e => set('target', e.target.value)} placeholder={form.action === 'slack' ? 'https://hooks.slack.com/services/…' : 'ops@company.com'} /></Field>}
    </div>
    <Note info className="mt-2.5">Rules are evaluated every minute. Page on-call e-mails active platform admins over SMTP; a firing rule opens an incident that resolves when the value recovers.</Note>
  </BwModal>
}

export default function PlatformMonitoringPage() {
  const { can } = usePlatformAccess()
  const canManage = can('monitoring', 'manage')
  const { error: showError } = useToast()
  const [service, setService] = useState('All services')
  const [range, setRange] = useState<MonitoringRange>('1h')
  const [data, setData] = useState<MonitoringOverview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [toggling, setToggling] = useState<number | null>(null)

  // Only the newest response is applied, so a slow earlier filter can't overwrite a newer one.
  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try { const { data: next } = await platformApi.monitoringOverview(service, range); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Monitoring data unavailable')) }
    finally { if (mine === seq.current) setLoading(false) }
  }, [service, range])
  useEffect(() => {
    setLoading(true)
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, LIVE_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const toggle = async (rule: MonitoringRule, enabled: boolean) => {
    setToggling(rule.id)
    setData(d => d && { ...d, rules: d.rules.map(r => r.id === rule.id ? { ...r, enabled } : r) })
    try { await platformApi.toggleAlertRule(rule.id, enabled); await load() }
    catch (err) { showError(errMsg(err, 'Unable to update the alert rule')); await load() } finally { setToggling(null) }
  }

  const k = data?.kpis
  const live = !!data && !error
  const labels = (data?.series ?? []).map((p, i) => i % 6 === 0 ? ago(p.minutes_ago) : '')
  const noMetrics = data && !data.request_metrics ? <Empty>{data.request_metrics_note}</Empty> : null
  const noTraffic = data?.request_metrics && !data.series.some(p => p.requests) ? <Empty>No {data.unit} in the last {range}</Empty> : null
  const unitLabel = data?.unit === 'queries' ? 'queries/s' : 'req/s'
  const rangeMinutes = { '1h': 60, '6h': 360, '24h': 1440, '7d': 10080 }[range]
  const collectingNote = data?.collecting_since && data.collecting_since * 1000 > Date.now() - rangeMinutes * 60_000
    ? `Collecting since ${new Date(data.collecting_since * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — earlier points have no data yet` : ''

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {creating && data && <NewRuleModal options={data.rule_options} onClose={() => setCreating(false)} onSaved={load} />}
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Monitoring</h1></div>
      <Pill t={live ? 'ok' : 'wa'} title={data ? `Updated ${new Date(data.generated_at).toLocaleTimeString()} · refreshes every ${LIVE_MS / 1000} s` : undefined}>
        <span className={`mr-[5px] inline-block h-[7px] w-[7px] rounded-full ${live ? 'animate-pulse' : ''}`} style={{ background: live ? '#3DDC97' : C.wa }} />{live ? 'Live' : 'Offline'}
      </Pill>
      <span className="flex-1" />
      <select className={`${inputCls} !w-[190px]`} style={inputStyle} value={service} onChange={e => setService(e.target.value)} aria-label="Service">{SERVICES.map(s => <option key={s}>{s}</option>)}</select>
      {RANGES.map(r => <button key={r} type="button" onClick={() => setRange(r)} className="inline-flex h-[22px] items-center rounded-[11px] border px-2 text-xs"
        style={r === range ? { background: C.ac, borderColor: C.ac, color: '#fff' } : { background: C.sf, borderColor: C.ln, color: C.tx }}>{r}</button>)}
    </div>
    {error && <Note className="mb-2">{error}{data ? ' · showing the last data received' : ''}</Note>}

    <Strip items={[
      { l: 'Availability · 30d', v: k?.availability_30d != null ? <span title={`Tracked over ${Math.round(k.availability_tracked_minutes / 1440 * 10) / 10} days by the uptime probe`}>{k.availability_30d}%</span> : <span title={k?.availability_reason || undefined}>—</span>,
        d: k ? `SLO ${k.slo_percent}%` : undefined, c: k?.availability_30d != null ? (k.availability_30d >= k.slo_percent ? C.ok : C.ba) : undefined, kpi: 'monitoring.availability' },
      { l: 'p95 latency', v: k?.p95_ms != null ? `${num(k.p95_ms)} ms` : '—', kpi: 'monitoring.p95' },
      { l: 'Error budget left', v: k?.error_budget_left != null ? <span style={{ color: k.error_budget_left <= 0 ? C.ba : k.error_budget_left < 25 ? C.wa : undefined }}>{pct(k.error_budget_left, 0)}</span> : '—', kpi: 'monitoring.error_budget' },
      { l: 'Apdex', v: k?.apdex != null ? <span title={`Target ${k.apdex_target_ms} ms`}>{k.apdex.toFixed(2)}</span> : '—', kpi: 'monitoring.apdex' },
      { l: 'Saturation', v: k?.saturation != null ? <span title={k.saturation_server ? `${k.saturation_server}${k.saturation_source === 'live' ? ' · live reading' : ` · average over ${range}`}` : undefined}>{Math.round(k.saturation)}%</span> : '—', d: 'CPU', kpi: 'monitoring.saturation' },
    ]} />

    {!data ? <Panel title="Monitoring"><Empty>{loading ? 'Loading…' : 'Monitoring data unavailable'}</Empty></Panel> : <>
      <div className="mb-2 grid gap-2 lg:grid-cols-2">
        <Panel title="Requests / s">{noMetrics || noTraffic || <>
          <LineChart series={[{ n: unitLabel, c: PAL[0], v: data.series.map(p => p.rps) }]} labels={labels} f={v => v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : String(Math.round(v))} />
          {collectingNote && <small className="block text-[11px]" style={{ color: C.mu }}>{collectingNote}</small>}
        </>}</Panel>
        <Panel title="Latency percentiles (ms)">{noMetrics || noTraffic || <LineChart series={[
          { n: 'p50', c: PAL[2], v: data.series.map(p => p.p50) }, { n: 'p95', c: PAL[1], v: data.series.map(p => p.p95) }, { n: 'p99', c: PAL[4], v: data.series.map(p => p.p99) },
        ]} labels={labels} />}</Panel>
      </div>

      <div className="mb-2 grid gap-2 lg:grid-cols-3">
        <Panel title="Error rate (%)">{noMetrics || noTraffic || <BarChart f={v => `${v}%`} data={data.series.map((p, i) => ({ l: labels[i], v: p.error_rate ?? 0, has: p.requests > 0, t: `${ago(p.minutes_ago)} · ${p.requests ? `${p.requests} ${data.unit}` : `no ${data.unit}`}` }))} />}</Panel>
        <Panel title="CPU / memory by service">
          <HBars rows={data.usage.map(u => ({ l: u.label, v: u.cpu, note: u.note, muted: u.note === 'Runs inside the API process', text: u.cpu == null ? 'n/a' : `${u.cpu}% / ${u.memory}%` }))} />
          <small className="mt-1 block text-[11px]" style={{ color: C.mu }}>CPU % of all cores / memory % of RAM, live</small>
        </Panel>
        <Panel title="Status page" flush>
          <div>{data.status.map(s => <div key={s.name} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }} title={s.detail}>
            <span className="flex-1">{s.name}</span><Pill t={STATUS_TONE[s.status] ?? 'mu'}>{s.status}</Pill>
          </div>)}</div>
        </Panel>
      </div>

      <div className="grid gap-2 lg:grid-cols-2">
        <Panel title="Alert rules" flush>
          <div>{data.rules.map(r => {
            const tip = [r.state === 'firing' ? `Firing${r.last_value != null ? ` · now ${r.last_value}` : ''}` : r.state === 'ok' ? `OK${r.last_value != null ? ` · now ${r.last_value}` : ''}` : r.state === 'no_data' ? 'No data in the window' : r.state === 'unavailable' ? `Unavailable · ${r.reason}` : r.state === 'pending' ? 'Not evaluated yet' : 'Disabled',
              r.delivery ? `Last notification: ${r.delivery}` : '', r.last_evaluated_at ? `Checked ${new Date(r.last_evaluated_at).toLocaleTimeString()}` : ''].filter(Boolean).join(' · ')
            return <div key={r.id} className="flex items-center gap-2 border-b px-2.5 py-1.5 last:border-0" style={{ borderColor: C.ln2 }} title={tip}>
              <Switch on={r.enabled} disabled={!canManage || toggling === r.id} label={r.label} onChange={v => void toggle(r, v)} />
              <span className="flex-1" style={{ color: r.state === 'firing' ? C.ba : r.state === 'unavailable' ? C.mu : undefined }}>{r.label}</span>
              <small className="text-xs" style={{ color: C.mu }}>{r.action_label}</small>
            </div>
          })}{!data.rules.length && <Empty>No alert rules</Empty>}</div>
          <div className="p-2"><Btn s disabled={!canManage} title={canManage ? undefined : 'Your platform role can’t change alert rules'} onClick={() => setCreating(true)}><Plus size={12} /> New alert rule</Btn></div>
        </Panel>
        <Panel title="Incidents" flush>
          {data.incidents.length ? <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 460 }}>
            <thead><tr><th>ID</th><th>Title</th><th>Sev</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>{data.incidents.map(i => <tr key={i.id} title={i.resolved_at ? `Resolved ${new Date(i.resolved_at).toLocaleString()}` : 'Open'}>
              <td className="whitespace-nowrap" style={{ color: C.ac }}>{i.code}</td><td>{i.title}</td><td>{i.severity}</td>
              <td><Pill t={i.status === 'Resolved' ? 'ok' : 'ba'}>{i.status}</Pill></td><td className="whitespace-nowrap">{fd(i.started_at)}</td>
            </tr>)}</tbody>
          </table></div> : <Empty>No incidents recorded</Empty>}
        </Panel>
      </div>
    </>}
  </div>
}
