import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { platformApi, PlatformBackup, PlatformDatabaseHealth, PlatformStats, PlatformSubscriptionSummary, PlatformTenant, PlatformAuditEntry, PlatformDashboardTenantUsage, PlatformDashboardTenantUserCount } from '@/services/platformApi'
import { Btn, C, Empty, Ic, Loading, Note, PageHead, Panel, Pill, Strip, Table, cap, fdt, num, statusTone, useKpiPopup, type Tone } from '@/components/platform/bw'
import { Donut, Gauge, HBars } from '@/components/platform/charts'
import NewTenantModal from '@/components/platform/NewTenantModal'

// Platform dashboard in the Bidwise prototype v9 language: KPI strip, analytical panels (donut, hbars, health gauge),
// the "Needs attention" list and a recent-tenants table. Every number comes from the platform API.
// Subscription donut segments, in subscriptionData order, as /subscriptions/summary states (drill-down filter).
const SUB_STATES = ['active', 'trial', 'expired', 'renewing']

export default function PlatformDashboardPage() {
  const navigate = useNavigate()
  const [openKpi, popup] = useKpiPopup()
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [tenants, setTenants] = useState<PlatformTenant[]>([])
  const [databaseHealth, setDatabaseHealth] = useState<Record<number, PlatformDatabaseHealth>>({})
  const [backups, setBackups] = useState<PlatformBackup[]>([])
  const [subscriptionSummary, setSubscriptionSummary] = useState<PlatformSubscriptionSummary | null>(null)
  const [recentActivity, setRecentActivity] = useState<PlatformAuditEntry[]>([])
  const [usageTenants, setUsageTenants] = useState<PlatformDashboardTenantUsage[]>([])
  const [tenantUserCount, setTenantUserCount] = useState<PlatformDashboardTenantUserCount | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newTenant, setNewTenant] = useState(false)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      // Only the fast, essential queries block the dashboard. The tenant-list endpoint
      // performs cross-database storage/user scans, so it must never run on page load.
      const [statsRes, tenantsRes] = await Promise.all([
        platformApi.stats(),
        platformApi.recentDashboardTenants(),
      ])
      const recentTenants = tenantsRes.data || []
      setStats(statsRes.data)
      setTenants(recentTenants)

      // Optional operational data is allowed to fail or time out without blanking the dashboard.
      void Promise.allSettled([
        platformApi.listBackups(),
        platformApi.subscriptionSummary(),
        platformApi.listAuditLogs({ limit: 5 }),
        platformApi.dashboardTenantUsage(),
        platformApi.dashboardTenantUserCount(),
        ...recentTenants.map(tenant => platformApi.tenantDatabaseHealth(tenant.id)),
      ]).then(results => {
        const [backupsResult, subscriptionsResult, activityResult, usageResult, usersResult, ...healthResults] = results
        if (backupsResult.status === 'fulfilled') setBackups(backupsResult.value.data || [])
        if (subscriptionsResult.status === 'fulfilled') setSubscriptionSummary(subscriptionsResult.value.data)
        if (activityResult.status === 'fulfilled') setRecentActivity(activityResult.value.data || [])
        if (usageResult.status === 'fulfilled') setUsageTenants(usageResult.value.data || [])
        if (usersResult.status === 'fulfilled') setTenantUserCount(usersResult.value.data)
        setDatabaseHealth(Object.fromEntries(healthResults.flatMap((result, index) => result.status === 'fulfilled' ? [[recentTenants[index].id, result.value.data]] : [])))
      })
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Unable to load dashboard')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const head = <PageHead crumb="Platform" title="Dashboard" sub="Platform-wide SaaS overview">
    <Btn onClick={() => void load()} disabled={loading} title="Refresh dashboard"><Ic n="clock" /> Refresh</Btn>
    {newTenant && <NewTenantModal onClose={() => setNewTenant(false)} />}
    <Btn p onClick={() => setNewTenant(true)}><Ic n="plus" /> New tenant</Btn>
    {popup}
  </PageHead>

  if (loading) return <div>{head}<Panel title="Dashboard"><Loading /></Panel></div>

  if (error) {
    return <div>{head}<Panel title="Dashboard loading failed"><Note>{error}</Note><div className="mt-2.5"><Btn onClick={() => void load()}>Retry</Btn></div></Panel></div>
  }

  const monitoredTenants: (PlatformTenant | PlatformDashboardTenantUsage)[] = usageTenants.length ? usageTenants : tenants
  const healthyDatabases = Object.values(databaseHealth).filter(h => h.health === 'healthy').length
  const checkedDatabases = Object.keys(databaseHealth).length
  const healthScore = checkedDatabases ? Math.round((healthyDatabases / checkedDatabases) * 100) : null
  const slowQueries = Object.values(databaseHealth).reduce((sum, health) => sum + (health.slow_queries || 0), 0)

  // Coverage is based on the latest backup for every tenant, not historical jobs.
  // A tenant is protected only when its completed backup file still exists.
  const latestBackupByTenant = new Map<number, PlatformBackup>()
  backups.forEach(backup => {
    const current = latestBackupByTenant.get(backup.tenant_id)
    const backupTime = Date.parse(backup.completed_at || backup.created_at) || 0
    const currentTime = current ? Date.parse(current.completed_at || current.created_at) || 0 : -1
    if (!current || backupTime > currentTime || (backupTime === currentTime && backup.id > current.id)) {
      latestBackupByTenant.set(backup.tenant_id, backup)
    }
  })

  const backupCoverage = { protected: 0, failed: 0, inProgress: 0, noBackup: 0 }
  monitoredTenants.forEach(tenant => {
    const latestBackup = latestBackupByTenant.get(tenant.id)
    const status = latestBackup?.status.toLowerCase()
    if (status === 'completed' && latestBackup?.available) backupCoverage.protected += 1
    else if (status === 'failed') backupCoverage.failed += 1
    else if (status === 'pending' || status === 'running' || status === 'in_progress') backupCoverage.inProgress += 1
    else backupCoverage.noBackup += 1
  })

  const failedBackups = backupCoverage.failed
  const overUserLimit = (tenant: PlatformTenant | PlatformDashboardTenantUsage) => 'user_count' in tenant && tenant.user_count != null && tenant.user_count >= tenant.max_users
  const atRiskTenants = monitoredTenants.filter(tenant => tenant.status === 'suspended' || tenant.status === 'cancelled' || overUserLimit(tenant) || (tenant.storage_limit_mb > 0 && tenant.used_storage / tenant.storage_limit_mb >= 0.8)).length
  const storageRows = monitoredTenants
    .map(tenant => ({ id: tenant.id, name: tenant.name, usage: tenant.storage_limit_mb ? Math.min(100, Math.round((tenant.used_storage / tenant.storage_limit_mb) * 100)) : 0 }))
    .sort((a, b) => b.usage - a.usage).slice(0, 7)
  const subscriptionData = [
    { l: 'Active', v: subscriptionSummary?.active ?? 0, c: 'var(--bw-ok)' },
    { l: 'Trial', v: subscriptionSummary?.trials ?? 0, c: 'var(--bw-wa)' },
    { l: 'Expired', v: subscriptionSummary?.expired ?? 0, c: 'var(--bw-ba)' },
    { l: 'Renewals due', v: subscriptionSummary?.renewals_due ?? 0, c: 'var(--bw-ac)' },
  ]
  const backupData = [
    { l: 'Protected', v: backupCoverage.protected, c: 'var(--bw-ok)' },
    { l: 'Failed', v: backupCoverage.failed, c: 'var(--bw-ba)' },
    { l: 'In progress', v: backupCoverage.inProgress, c: 'var(--bw-wa)' },
    { l: 'No backup', v: backupCoverage.noBackup, c: 'var(--bw-mu)' },
  ]
  const alerts = [
    { label: 'Expired subscriptions', value: subscriptionSummary?.expired ?? 0, tone: 'ba' as Tone, to: '/platform/subscriptions' },
    { label: 'Renewals due within 30 days', value: subscriptionSummary?.renewals_due ?? 0, tone: 'wa' as Tone, to: '/platform/subscriptions' },
    { label: 'Suspended tenants', value: stats?.suspended_tenants ?? 0, tone: 'ba' as Tone, to: '/platform/tenants' },
    { label: 'Failed backups', value: failedBackups, tone: 'ba' as Tone, to: '/platform/tenants' },
    { label: 'At-risk tenant accounts', value: atRiskTenants, tone: 'wa' as Tone, to: '/platform/tenants' },
  ].filter(alert => alert.value > 0) as { label: string; value: number; tone: Tone; to: string }[]

  return (
    <div>
      {head}

      <Strip min={128} items={[
        { l: 'Total tenants', kpi: 'dashboard.total_tenants', v: num(stats?.total_tenants ?? 0) },
        { l: 'Active tenants', kpi: 'dashboard.active_tenants', v: num(stats?.active_tenants ?? 0), dc: 'tok' },
        { l: 'Trial tenants', kpi: 'dashboard.trial_tenants', v: num(stats?.trial_tenants ?? 0), dc: stats?.trial_tenants ? 'twarn' : undefined },
        { l: 'Expired tenants', kpi: 'dashboard.expired_tenants', v: num(subscriptionSummary?.expired ?? 0), dc: subscriptionSummary?.expired ? 'tbad' : undefined },
        { l: 'Tenant users', kpi: 'dashboard.tenant_users', v: num(tenantUserCount?.total_users ?? 0), d: tenantUserCount?.unavailable_tenants ? `${tenantUserCount.unavailable_tenants} not reachable` : undefined, dc: tenantUserCount?.unavailable_tenants ? 'twarn' : undefined },
        { l: 'Suspended tenants', kpi: 'dashboard.suspended_tenants', v: num(stats?.suspended_tenants ?? 0), dc: stats?.suspended_tenants ? 'tbad' : undefined },
        { l: 'System health', kpi: 'dashboard.system_health', v: healthScore == null ? '—' : `${healthScore}%`, d: checkedDatabases ? `${healthyDatabases}/${checkedDatabases} databases` : 'Not checked', dc: healthScore == null ? undefined : healthScore === 100 ? 'tok' : 'twarn' },
        { l: 'Active admins', kpi: 'dashboard.active_admins', v: num(stats?.total_super_admins ?? 0) },
      ]} />

      <div className="mb-2 grid gap-2 lg:grid-cols-2">
        <Panel title="Subscription overview" act={<Link to="/platform/subscriptions">Subscriptions →</Link>}>
          {subscriptionSummary?.total_subscriptions
            ? <Donut data={subscriptionData} f={num} center={num(subscriptionSummary.total_subscriptions)} caption="subscriptions"
              onPick={i => openKpi({ kpi: 'dashboard.subscriptions', title: `${subscriptionData[i].l} subscriptions`, value: num(subscriptionData[i].v), query: { status: SUB_STATES[i] } })} />
            : <Empty>No subscriptions</Empty>}
        </Panel>
        <Panel title="Tenant storage · % of plan limit" act={<Link to="/platform/usage-monitoring">Usage monitoring →</Link>}>
          {storageRows.length
            ? <HBars lw={150} vw={44} onPick={i => navigate(`/platform/tenants/${storageRows[i].id}`)} rows={storageRows.map(r => ({ l: r.name, v: r.usage, text: `${r.usage}%`, c: r.usage >= 80 ? 'var(--bw-ba)' : r.usage >= 65 ? 'var(--bw-wa)' : undefined }))} />
            : <Empty>No usage data available</Empty>}
        </Panel>
        <Panel title="Backup coverage">
          {monitoredTenants.length
            ? <Donut data={backupData} f={num} center={`${backupCoverage.protected}/${monitoredTenants.length}`} caption="protected"
              onPick={i => openKpi({ kpi: 'dashboard.backups', title: `Backup coverage · ${backupData[i].l}`, value: num(backupData[i].v), query: { facet: backupData[i].l } })} />
            : <Empty>No tenants found</Empty>}
        </Panel>
        <Panel title="System & customer health" act={<Link to="/platform/tenants">Tenants →</Link>}>
          <div className="flex items-center gap-5">
            <Gauge v={healthScore} label={healthScore == null ? 'not checked' : 'healthy'} />
            <div className="min-w-0 flex-1">
              {([
                ['Databases available', checkedDatabases ? `${healthyDatabases}/${checkedDatabases}` : 'Not checked', checkedDatabases && healthyDatabases === checkedDatabases ? 'ok' : 'wa', 'dashboard.system_health'],
                ['Slow queries', num(slowQueries), slowQueries ? 'wa' : 'ok', 'dashboard.system_health'],
                ['At-risk tenants', num(atRiskTenants), atRiskTenants ? 'wa' : 'ok', 'command.storage'],
                ['Failed backups', num(failedBackups), failedBackups ? 'ba' : 'ok', 'dashboard.backups', { facet: 'Failed' }],
              ] as [string, string, Tone, string, { facet?: string }?][]).map(([l, v, t, kpi, query]) => <button type="button" key={l} onClick={() => openKpi({ kpi, title: l, value: v, query })} title={`${l} — click for details`}
                className="flex w-full items-center justify-between gap-2 border-b py-[6px] text-left last:border-0 hover:bg-[var(--bw-hd)]" style={{ borderColor: C.ln2 }}><span style={{ color: C.mu }}>{l}</span><Pill t={t}>{v}</Pill></button>)}
            </div>
          </div>
        </Panel>
      </div>

      <div className="mb-2 grid gap-2 lg:grid-cols-2">
        <Panel title="Needs attention" flush>
          {alerts.length
            ? <div className="bw-list">{alerts.map(alert => <div key={alert.label}><Pill t={alert.tone}>{alert.tone === 'ba' ? 'Critical' : 'Warning'}</Pill><span className="flex-1">{alert.label}</span><b className="tabular-nums">{num(alert.value)}</b><Link to={alert.to}>Open</Link></div>)}</div>
            : <Empty><span style={{ color: C.ok }}>No active platform alerts</span></Empty>}
        </Panel>
        <Panel title="Recent activity" act={<Link to="/platform/audit">Audit trail →</Link>} flush>
          {recentActivity.length
            ? <div className="bw-list">{recentActivity.slice(0, 5).map(entry => <div key={entry.id}>
                <span className="min-w-0 flex-1"><b className="block truncate font-medium">{entry.description || entry.action.replace(/_/g, ' ')}</b><small style={{ color: C.mu }}>{entry.performed_by || 'System'} · {fdt(entry.created_at)}</small></span>
                <Pill t="ac">{entry.entity_type}</Pill>
              </div>)}</div>
            : <Empty>No recent platform activity</Empty>}
        </Panel>
      </div>

      <Panel title="Recent tenants" act={<Link to="/platform/tenants">View all →</Link>} flush>
        {tenants.length
          ? <Table head={['Tenant', 'Slug', 'Status', 'Billing', 'Admin', { t: 'Max users', r: true }]}>
              {tenants.map(tenant => <tr key={tenant.id} className="cursor-pointer" onClick={() => navigate(`/platform/tenants/${tenant.id}`)}>
                <td><b>{tenant.name}</b></td>
                <td style={{ color: C.mu }}>{tenant.slug}</td>
                <td><Pill t={statusTone(tenant.status)}>{cap(tenant.status)}</Pill></td>
                <td><Pill t={tenant.billing_status === 'past_due' ? 'ba' : tenant.billing_status === 'free' ? 'ac' : statusTone(tenant.billing_status || 'trial')}>{cap(tenant.billing_status || "trial")}</Pill></td>
                <td>{tenant.admin_email}</td>
                <td className="text-right">{num(tenant.max_users)}</td>
              </tr>)}
            </Table>
          : <Empty>No tenants found</Empty>}
      </Panel>
    </div>
  )
}
