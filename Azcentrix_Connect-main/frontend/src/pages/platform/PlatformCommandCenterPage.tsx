import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import NewTenantModal from '@/components/platform/NewTenantModal'
import {
  platformApi,
  type PlatformBackup,
  type PlatformCommandCenterLive,
  type PlatformCommandCenterSummary,
  type PlatformDashboardTenantUsage,
  type PlatformInfrastructure,
  type PlatformServer,
  type PlatformStats,
  type PlatformTenantPlacement,
} from '@/services/platformApi'
import { Btn, C, Empty, Hero, Ic, Note, PageHead, Panel, Pill, Strip, Table, inr, num } from '@/components/platform/bw'
import { HBars, LineChart, Meter, PAL } from '@/components/platform/charts'

// Section names, KPI labels, order and chart types follow the Bidwise prototype Command Center (P.overview):
// live hero band, KPI strip, fleet map + live traffic, three list panels, region status.
const LIVE_MS = 3000
const SLOW_MS = 15000

const storage = (mb: number) => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
const ago = (at: number) => { const s = Date.now() / 1000 - at; return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d` }
const load = (v: number) => v > 85 ? C.ba : v > 70 ? C.wa : C.ok
const pct = (v: number | null | undefined) => v != null ? `${Math.round(v)}%` : '—'

// Prototype fleetMap(): one column per server — name, region · role, CPU meter, metrics line, then its tenants.
function FleetColumn({ s, tenants }: { s: PlatformServer & { region?: string }; tenants: PlatformTenantPlacement[] }) {
  const m = s.metrics, db = s.database
  return <div className="min-w-0 rounded-lg border p-2.5" style={{ background: C.hd, borderColor: C.ln }}>
    <div className="flex items-center gap-2"><b className="flex-1 truncate text-[12px]">{s.name}</b><Pill t={s.status === 'Online' ? 'ok' : 'ba'}>{s.status}</Pill></div>
    <small className="block truncate text-[10.5px]" style={{ color: C.mu }}>{[s.region, s.roles.join(' + ') || 'Server', s.ip].filter(Boolean).join(' · ')}</small>
    {m.available ? <>
      <div className="mt-2"><Meter v={m.cpu_percent ?? 0} c={load(m.cpu_percent ?? 0)} /></div>
      <small className="mt-1 block text-[10.5px]" style={{ color: C.mu }}>CPU {pct(m.cpu_percent)} · mem {pct(m.memory_percent)} · disk {pct(m.disk_percent)}</small>
    </> : <small className="mt-2 block text-[10.5px]" style={{ color: C.mu }}>OS metrics: {m.error || 'unavailable'}</small>}
    <small className="mt-0.5 block truncate text-[10.5px]" style={{ color: C.mu }} title={db?.error || undefined}>
      DB {db ? (db.reachable && db.latency_ms != null ? `${db.status} · ${db.latency_ms} ms · ${db.connections}/${db.max_connections} conn` : db.error || 'Unreachable') : 'not hosted'}
    </small>
    <div className="mt-2 space-y-1">
      {tenants.map(t => <Link key={t.id} to={`/platform/tenants/${t.id}`} title={`${t.db_name} · ${t.db_status}${t.db_size_mb != null ? ` · ${t.db_size_mb} MB` : ''}`}
        className="flex items-center gap-1.5 rounded border px-1.5 py-[3px] text-[11px] hover:no-underline" style={{ background: C.sf, borderColor: C.ln2, color: C.tx }}>
        <span className="h-2 w-2 flex-none rounded-full" style={{ background: t.db_status === 'Available' ? (t.status === 'active' || t.status === 'trial' ? C.ok : C.wa) : C.ba }} />
        <span className="truncate">{t.slug.toUpperCase()} · {t.name}</span>
      </Link>)}
      {!tenants.length && <small className="block text-[11px]" style={{ color: C.mu }}>{s.tenant_count ? `${s.tenant_count} tenants` : 'No tenants'}</small>}
    </div>
  </div>
}

export default function PlatformCommandCenterPage() {
  const navigate = useNavigate()
  const [live, setLive] = useState<PlatformCommandCenterLive | null>(null)
  const [newTenant, setNewTenant] = useState(false)
  const [summary, setSummary] = useState<PlatformCommandCenterSummary | null>(null)
  const [infra, setInfra] = useState<PlatformInfrastructure | null>(null)
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [usage, setUsage] = useState<PlatformDashboardTenantUsage[]>([])
  const [backups, setBackups] = useState<PlatformBackup[]>([])
  const [error, setError] = useState('')

  const loadLive = useCallback(async () => {
    try { setLive((await platformApi.dashboardCommandCenter()).data); setError('') }
    catch (err: any) { setError(err?.response?.data?.detail || 'Live metrics unavailable. Check that the backend is running the latest version.') }
  }, [])
  const loadSlow = useCallback(async () => {
    const [infraRes, summaryRes, statsRes, usageRes, backupsRes] = await Promise.allSettled([
      platformApi.dashboardInfrastructure(), platformApi.dashboardCommandCenterSummary(), platformApi.stats(), platformApi.dashboardTenantUsage(), platformApi.listBackups(),
    ])
    if (infraRes.status === 'fulfilled') setInfra(infraRes.value.data)
    if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value.data)
    if (statsRes.status === 'fulfilled') setStats(statsRes.value.data)
    if (usageRes.status === 'fulfilled') setUsage(usageRes.value.data || [])
    if (backupsRes.status === 'fulfilled') setBackups(backupsRes.value.data || [])
  }, [])

  useEffect(() => {
    void loadLive(); void loadSlow()
    const timers = [
      window.setInterval(() => { if (!document.hidden) void loadLive() }, LIVE_MS),
      window.setInterval(() => { if (!document.hidden) void loadSlow() }, SLOW_MS),
    ]
    return () => timers.forEach(window.clearInterval)
  }, [loadLive, loadSlow])

  const servers = infra?.servers ?? []
  const regions = infra?.regions ?? []
  const targets = summary?.targets
  const dbServers = servers.filter(s => s.database?.reachable)
  const dbConn = dbServers.reduce((a, s) => a + (s.database?.connections || 0), 0)
  const dbMax = dbServers.reduce((a, s) => a + (s.database?.max_connections || 0), 0)
  const online = servers.filter(s => s.status === 'Online').length
  const uptimes = servers.map(s => s.uptime_30d).filter((v): v is number => v != null)
  const uptime30 = uptimes.length ? uptimes.reduce((a, v) => a + v, 0) / uptimes.length : null
  const storageMB = usage.reduce((a, t) => a + Number(t.used_storage || 0), 0)
  const budgetLeft = live && targets ? Math.max(0, 100 - live.error_rate / targets.error_budget_percent * 100) : null

  const latestBackup = new Map<number, PlatformBackup>()
  backups.forEach(b => { const cur = latestBackup.get(b.tenant_id); if (!cur || Date.parse(b.completed_at || b.created_at) > Date.parse(cur.completed_at || cur.created_at)) latestBackup.set(b.tenant_id, b) })
  const failedBackups = [...latestBackup.values()].filter(b => b.status.toLowerCase() === 'failed').length
  const attention = [
    ...servers.flatMap(s => s.metrics.available ? ([['CPU', s.metrics.cpu_percent, targets?.cpu_alert_percent ?? 85], ['RAM', s.metrics.memory_percent, 85], ['Disk', s.metrics.disk_percent, 85]] as const).filter(([, v, max]) => v != null && v >= max).map(([l, v]) => ({ severity: 'warning', message: `${s.name} ${l} at ${Math.round(v!)}%`, link: '' })) : []),
    ...(infra?.tenants ?? []).filter(t => t.db_status === 'Missing').map(t => ({ severity: 'critical', message: `${t.name} database ${t.db_name} not found`, link: '/platform/tenants' })),
    ...(failedBackups ? [{ severity: 'critical', message: `${failedBackups} tenant${failedBackups > 1 ? 's' : ''} with a failed latest backup`, link: '/platform/tenants' }] : []),
    ...(live?.attention ?? []),
  ]
  const openIncidents = summary?.open_incidents.length ?? 0
  const warnings = attention.filter(x => x.severity === 'warning').length
  const labels = (live?.series ?? []).map((p, i) => i % 8 === 0 ? (p.seconds_ago ? `-${p.seconds_ago}s` : 'now') : '')

  const strip = [
    { l: 'Tenants', kpi: 'command.tenants', v: stats ? num(stats.total_tenants) : '—' },
    { l: 'Active', kpi: 'command.active', v: stats ? num(stats.active_tenants) : '—', d: stats ? `${stats.trial_tenants} trial` : '', dc: 'twarn' as const },
    { l: 'MRR', kpi: 'command.mrr', v: summary ? inr(summary.mrr) : '—', d: summary ? `${summary.paying_tenants} paying` : '', dc: 'tok' as const },
    { l: 'Storage', kpi: 'command.storage', v: usage.length ? storage(storageMB) : '—' },
    { l: 'Uptime · 30d', kpi: 'command.uptime', v: uptime30 != null ? `${uptime30.toFixed(2)}%` : '—', d: targets ? `SLA ${targets.sla_percent}%` : '', dc: uptime30 == null || !targets || uptime30 >= targets.sla_percent ? 'tok' as const : 'tbad' as const },
    { l: 'Open incidents', kpi: 'command.incidents', v: summary ? num(openIncidents) : '—', d: `${warnings} warning${warnings === 1 ? '' : 's'}`, dc: openIncidents ? 'tbad' as const : 'twarn' as const },
  ]
  const eventPill = { deploy: <Pill t="ok">Done</Pill>, resolved: <Pill t="wa">Resolved</Pill>, incident: <Pill t="ba">Incident</Pill> }

  return <div>
    <PageHead crumb="Platform" title="Command center" cnt={<Pill t="ok"><span className="livedot" />Live · refreshes every 3 s</Pill>}>
      <Btn onClick={() => navigate('/platform/monitoring')}>Open monitoring</Btn>
      {newTenant && <NewTenantModal onClose={() => setNewTenant(false)} />}
      <Btn p onClick={() => setNewTenant(true)}><Ic n="plus" /> New tenant</Btn>
    </PageHead>
    {error && <div role="alert" className="mb-2"><Note>{error}</Note></div>}

    <Hero cells={[
      { l: 'Requests / sec', kpi: 'command.requests', v: live ? (live.requests_per_second < 10 ? live.requests_per_second.toFixed(2) : num(live.requests_per_second)) : '—', sub: `across ${regions.length || '—'} region${regions.length === 1 ? '' : 's'}` },
      { l: 'API p95 latency', kpi: 'command.p95', v: live?.p95_ms != null ? `${Math.round(live.p95_ms)} ms` : '—', sub: targets ? `SLO ${targets.p95_ms} ms` : 'SLO' },
      { l: 'Error rate', kpi: 'command.error_rate', v: live ? `${live.error_rate.toFixed(2)}%` : '—', sub: budgetLeft != null ? `budget ${Math.round(budgetLeft)}% left` : 'budget' },
      { l: 'Active sessions', kpi: 'command.sessions', v: summary ? num(summary.active_sessions) : '—', sub: summary ? `${num(summary.provisioned_users)} provisioned users` : 'provisioned users' },
      { l: 'DB connections', kpi: 'command.db_connections', v: dbServers.length ? num(dbConn) : '—', sub: dbMax ? `of ${num(dbMax)} max` : 'of — max' },
      { l: 'Queue depth', kpi: 'jobs.queued', v: live?.queue_depth != null ? num(live.queue_depth) : '—', sub: summary?.dead_letter != null ? `${summary.dead_letter} dead-letter` : 'dead-letter unavailable' },
    ]} />

    <Strip items={strip} />

    <div className="mb-2 grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel title="Fleet map · servers and tenants" act={<Link to="/platform/databases">Databases →</Link>}>
        {!infra ? <Empty>Loading live server metrics…</Empty> : <>
          <small className="mb-2 block" style={{ color: C.mu }}>{infra.mode === 'single' ? 'Single-server deployment' : `${servers.length} servers`} · {online} online · {infra.tenants.length} tenants</small>
          <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
            {servers.map(s => <FleetColumn key={s.name} s={s} tenants={infra.tenants.filter(t => t.server === s.name)} />)}
          </div>
          {infra.tenants.some(t => !t.server) && <Note className="mt-2.5">Not mapped to a server: {infra.tenants.filter(t => !t.server).map(t => `${t.name} (${t.db_name} · ${t.db_status})`).join(', ')}</Note>}
        </>}
      </Panel>
      <Panel title="Live traffic">
        {live?.series.length ? <>
          <LineChart h={150} labels={labels} series={[{ n: 'Requests / s', c: PAL[0], v: live.series.map(p => p.rps) }]} f={v => v < 10 ? v.toFixed(1) : String(Math.round(v))} />
          <div className="mt-2"><LineChart h={120} labels={labels} series={[{ n: 'p95 ms', c: PAL[1], v: live.series.map(p => p.p95_ms) }]} /></div>
        </> : <Empty>Waiting for live traffic…</Empty>}
      </Panel>
    </div>

    <div className="mb-2 grid gap-2 lg:grid-cols-3">
      <Panel title="Most active tenants · requests / min">
        {live?.active_tenants.length
          ? <HBars lw={150} vw={40} onPick={i => navigate(`/platform/tenants/${live.active_tenants[i].id}`)} rows={live.active_tenants.map(t => ({ l: `${t.slug.toUpperCase()} · ${t.name.slice(0, 14)}`, v: t.requests_per_minute, text: num(t.requests_per_minute) }))} />
          : <Empty>No tenant API traffic in the last 5 minutes.</Empty>}
      </Panel>
      <Panel title="Deployments & incidents" flush>
        {summary?.events.length ? <div className="bw-list">{summary.events.map((e, i) => <div key={i}>{eventPill[e.kind]}<span className="flex-1">{e.text}</span><small style={{ color: C.mu }}>{ago(e.at)}</small></div>)}</div> : <Empty>No deployments or incidents recorded yet.</Empty>}
      </Panel>
      <Panel title="Needs attention" flush>
        {attention.length ? <div className="bw-list">{attention.slice(0, 8).map((x, i) => <div key={i}><Pill t={x.severity === 'critical' ? 'ba' : x.severity === 'warning' ? 'wa' : 'inf'}>{x.severity === 'critical' ? 'Critical' : x.severity === 'warning' ? 'Warning' : 'Info'}</Pill><span className="flex-1">{x.message}</span>{x.link && <Link to={x.link}>Open</Link>}</div>)}</div> : <Empty>Nothing needs attention.</Empty>}
      </Panel>
    </div>

    <Panel title="Region status" flush>
      {!infra ? <Empty>Loading region status…</Empty> : <Table head={['Region', 'Status', { t: 'Clusters', r: true }, { t: 'Tenants', r: true }, { t: 'Latency', r: true }, 'Uptime 30d']}>
        {regions.map(r => <tr key={r.region}>
          <td><b>{r.region}</b> · {r.servers.join(', ')}</td>
          <td><Pill t={r.status === 'Operational' ? 'ok' : r.status === 'Degraded' ? 'wa' : 'ba'}>{r.status}</Pill></td>
          <td className="text-right">{r.clusters}</td>
          <td className="text-right">{r.tenants}</td>
          <td className="text-right">{r.latency_ms != null ? `${Math.round(r.latency_ms)} ms` : '—'}</td>
          <td>{r.uptime_30d != null ? `${r.uptime_30d}%` : '—'}</td>
        </tr>)}
      </Table>}
    </Panel>
  </div>
}
