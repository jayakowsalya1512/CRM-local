import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Database, Download, HardDrive, Play, RefreshCw, Settings, Wrench } from 'lucide-react'
import {
  isApprovalQueued, platformApi,
  type HierarchyGroupRow, type NegotiatedDiscount, type ParentVisibility, type PlatformAuditRow, type PlatformPlan, type PlatformTenant, type TenantAuditEntry, type TenantBackupRow,
  type TenantConfiguration, type TenantDatabase, type TenantFeaturesResponse, type TenantMeter, type TenantMonitoring, type TenantOverview,
  type TenantPlanHistoryEntry, type TenantQueryResult, type TenantSecurity, type TenantAddon, type TenantDiscounts, type TenantSettingsOverrides, type TenantUserRow,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import {
  Bar, Btn, BwModal, C, Empty, Field, HBars, Kv, Loading, Note, Panel, Pill, Strip, Switch, Table, Tabs, VISIBILITY_LABEL,
  cap, downloadBlob, errMsg, fd, fdt, inputCls, inputStyle, inr, mb, num, statusTone,
} from '@/components/platform/bw'
import { LineChart, PAL } from '@/components/platform/charts'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import TenantDataMigrationTab from './TenantDataMigrationTab'
import { ControlLayout, useControls } from './PlatformControlCenterPage'

export const TENANT_TABS = ['Overview', 'Settings overrides', 'Contract & discounts', 'Database', 'Monitoring', 'Backups & recovery', 'Data & migration', 'Modules', 'Users & access', 'Configuration', 'Limits & metering', 'Billing', 'Security', 'Hierarchy', 'Lifecycle', 'Audit'] as const
type Ctx = { id: number; ov: TenantOverview; reload: () => Promise<void>; canManage: boolean }
// Overview record cards (hierarchy.RECORD_TABLES labels) → their KPI drill-down.
const RECORD_KPI: Record<string, string> = { Customers: 'tenant.customers', Leads: 'tenant.leads', Tenders: 'tenant.tenders', Quotations: 'tenant.quotations' }
type Confirm = { title: string; body: ReactNode; label: string; danger?: boolean; typed?: string; run: (typed: string) => Promise<void> }

function useLoad<T>(fn: () => Promise<{ data: T }>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try { setData((await fn()).data); setError('') } catch (err) { setError(errMsg(err, 'Unable to load data')) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => { void load() }, [load])
  return { data, error, load, setData }
}

function ConfirmModal({ c, onClose }: { c: Confirm; onClose: () => void }) {
  const { error: showError } = useToast()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (c.typed && typed.trim() !== c.typed) return showError(c.typed.includes(' ') ? 'Name does not match' : 'Type the tenant short name to confirm')
    setBusy(true)
    try { await c.run(typed.trim()); onClose() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(false) }
  }
  return <BwModal title={c.title} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn>{c.danger ? <Btn d onClick={() => void run()} disabled={busy}>{busy ? 'Working…' : c.label}</Btn> : <Btn p onClick={() => void run()} disabled={busy}>{busy ? 'Working…' : c.label}</Btn>}</>}>
    <div className="space-y-2.5">{c.body}{c.typed && <Field label={`Type ${c.typed} to confirm`}><input className={inputCls} style={inputStyle} value={typed} onChange={e => setTyped(e.target.value)} autoFocus /></Field>}</div>
  </BwModal>
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

function OverviewTab({ id, ov, reload, canManage, ask }: Ctx & { ask: (c: Confirm) => void }) {
  const { success, info, error: showError } = useToast()
  const m = ov.metrics
  const kq = { tenant_id: id }
  const exportData = async () => {
    try { downloadBlob((await platformApi.exportTenantData(id)).data as Blob, `tenant_${ov.slug}_export.sql`); success('Export downloaded') } catch (err) { showError(errMsg(err, 'Export failed')) }
  }
  return <div className="grid gap-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
    <div className="space-y-2">
      <Panel title="Profile"><Kv rows={[
        ['Tenant ID', `#${ov.id} · ${ov.slug.toUpperCase()}`],
        ['Type', ov.parent_group_id ? <>Company under <Link to={`/platform/tenant-groups/${ov.parent_group_id}`} style={{ color: C.ac }}>{ov.parent_name}</Link></> : 'Standalone'],
        ['Industry', ov.industry || '—'], ['Domain', ov.subdomain], ['Created', fd(ov.created_at)],
        ['Region', ov.region || '—'], ['Plan', ov.plan?.name || '—'], ['Primary admin', `${ov.admin_name} · ${ov.admin_email}`],
        ['Database', <code key="d" className="text-xs">{ov.db_name}</code>], ['Server', ov.server ? `${ov.server}${ov.server_ip ? ` · ${ov.server_ip}` : ''}` : <span style={{ color: C.ba }}>Database not found</span>],
      ]} /></Panel>
      <Panel title="Usage vs plan"><HBars rows={[
        // The user limit applies to active users (the tenant app blocks new users at the limit); deactivated ones don't count.
        { l: `Active users (${num(m.active_users)} / ${num(ov.max_users)})`, v: m.active_users != null && ov.max_users ? m.active_users / ov.max_users * 100 : null },
        { l: `Storage (${mb(ov.storage_mb)} / ${mb(ov.storage_limit_mb)})`, v: ov.storage_limit_mb ? ov.storage_mb / ov.storage_limit_mb * 100 : null },
        { l: `Weekly active users (${num(m.weekly_active)} / ${num(m.active_users)})`, v: ov.health },
        { l: `Active sessions (${num(m.active_sessions)})`, v: m.active_sessions != null && m.active_users ? m.active_sessions / m.active_users * 100 : null },
      ]} /></Panel>
      {Object.keys(m.records).length > 0 && <Strip items={[{ l: 'Database size', v: mb(ov.db_size_mb), kpi: 'tenant.db_size', kpiQuery: kq }, ...Object.entries(m.records).map(([l, v]) => ({ l, v: num(v), kpi: RECORD_KPI[l], kpiQuery: kq })), { l: 'Last backup', v: ov.last_backup_at ? fd(ov.last_backup_at) : 'Never', c: ov.last_backup_at ? C.ok : C.wa, kpi: 'tenant.last_backup', kpiQuery: kq }]} />}
    </div>
    <div className="space-y-2">
      <Panel title="Health score">
        <div className="text-[26px] font-semibold">{ov.health ?? '—'}<small className="text-sm font-normal" style={{ color: C.mu }}> / 100</small></div>
        <Bar value={ov.health} />
        <p className="mt-2 text-xs" style={{ color: C.mu }}>Weekly active users as a share of enabled users{m.last_activity ? ` · last activity ${fdt(m.last_activity)}` : ''}.</p>
      </Panel>
      <Panel title="Quick actions"><div className="grid gap-1.5">
        <Link to={`/platform/tenants/${id}?tab=Configuration`} className="inline-flex h-7 items-center gap-1.5 rounded-md border px-[11px] font-medium text-white" style={{ background: C.ac, borderColor: C.ac, color: '#fff' }}><Settings size={14} /> Configure tenant</Link>
        <Btn onClick={() => void exportData()}><Download size={14} /> Export tenant data</Btn>
        {canManage && <Btn onClick={() => ask({ title: 'Force sign-out all users', label: 'Sign out everyone', danger: true, body: <p>All active sessions for {ov.name} are invalidated. Every user must sign in again.</p>, run: async () => { await platformApi.forceLogoutTenant(id, 'Forced logout by platform admin'); success('All sessions invalidated') } })}>Force sign-out all users</Btn>}
        {canManage && (ov.status === 'suspended'
          ? <Btn d onClick={() => ask({ title: 'Reactivate tenant', label: 'Yes, continue', body: <p>Reactivate this tenant?</p>, run: async () => { await platformApi.reactivateTenant(id); success('Tenant active'); await reload() } })}>Reactivate tenant</Btn>
          : <Btn d onClick={() => ask({ title: 'Suspend tenant', label: 'Yes, continue', danger: true, body: <p>Suspend {ov.name}? Users will be blocked from signing in immediately.</p>, run: async () => { const { data } = await platformApi.suspendTenant(id); if (isApprovalQueued(data)) info('Sent for approval', data.message); else success('Tenant suspended'); await reload() } })}>Suspend tenant</Btn>)}
      </div></Panel>
    </div>
  </div>
}

const showValue = (v: unknown) => v == null || v === '' ? '—' : typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v)

function SettingsTab({ id, ov }: Ctx) {
  const { data, error } = useLoad<TenantSettingsOverrides>(() => platformApi.tenantSettingsOverrides(id), [id])
  const ctl = useControls(id)
  const { can } = usePlatformAccess()
  return <div className="space-y-2">
    <Note info>Every tenant-level control below overrides the platform default for <b>{ov.name}</b>. Changes apply only to this tenant. <Link to={`/platform/tenants/${id}?tab=Configuration`} style={{ color: C.ac }}>Tenant configuration →</Link></Note>
    {error ? <Note>{error}</Note> : !data ? <Loading /> : <div className="grid gap-2 xl:grid-cols-2">{data.sections.map(s => <Panel key={s.title} title={s.title} flush act={<small className="text-xs font-normal" style={{ color: C.mu }}>{s.settings.filter(x => x.overridden).length} overridden</small>}>
      <Table head={['Setting', 'Platform default', 'This tenant', '']} minWidth={420}>{s.settings.map(x => <tr key={x.key}><td>{x.label}</td><td style={{ color: C.mu }}>{showValue(x.platform_default)}</td><td className="font-semibold">{showValue(x.value)}</td><td>{x.overridden ? <Pill t="ac">Overridden</Pill> : <Pill t="mu">Inherited</Pill>}</td></tr>)}</Table>
    </Panel>)}</div>}
    <h2 className="pt-1 text-sm font-semibold">Control center overrides <small className="text-xs font-normal" style={{ color: C.mu }}>Every control from the Control center can be overridden for {ov.name}; anything not overridden inherits the platform default.</small></h2>
    <ControlLayout ctl={ctl} canManage={can('settings', 'manage')} />
  </div>
}

function DatabaseTab({ id, ov, canManage, ask }: Ctx & { ask: (c: Confirm) => void }) {
  const { success } = useToast()
  const { data: db, error, load } = useLoad<TenantDatabase>(() => platformApi.tenantDatabase(id), [id])
  const slow = useLoad(() => platformApi.tenantSlowQueries(id), [id])
  const [sql, setSql] = useState('SELECT id, full_name, role, last_login FROM users ORDER BY last_login DESC LIMIT 20')
  const [result, setResult] = useState<TenantQueryResult | null>(null)
  const [queryError, setQueryError] = useState('')
  const [running, setRunning] = useState(false)
  const runQuery = async () => {
    setRunning(true); setQueryError('')
    try { setResult((await platformApi.tenantDatabaseQuery(id, sql)).data) } catch (err) { setResult(null); setQueryError(errMsg(err, 'Query failed')) } finally { setRunning(false) }
  }
  const maint = (action: 'analyze' | 'optimize' | 'schema_sync', name: string, interrupts: boolean) => ask({
    title: `Run “${name}”`, label: 'Run',
    body: <p>Run “{name}” on {ov.name}? {interrupts ? 'Tables are rebuilt one at a time and briefly locked while rebuilding.' : 'This runs online with no downtime.'}</p>,
    run: async () => { const { data } = await platformApi.tenantDatabaseMaintenance(id, action); success(data.message); await load() },
  })
  const snapshot = () => ask({ title: 'Snapshot now', label: 'Run', body: <p>Take an on-demand backup of <code>{ov.db_name}</code> now?</p>, run: async () => { await platformApi.createTenantBackup(id); success('Snapshot completed – see Backups & recovery'); await load() } })
  if (error) return <Note>{error}</Note>
  if (!db) return <Loading />
  const kq = { tenant_id: id }
  const actions: [string, string, () => void, ReactNode][] = [
    ['ANALYZE TABLE', 'Refresh index statistics for the query planner', () => maint('analyze', 'ANALYZE TABLE', false), <Wrench key="a" size={14} />],
    ['OPTIMIZE TABLE', 'Rebuild tables and indexes, reclaim free space', () => maint('optimize', 'OPTIMIZE TABLE', true), <RefreshCw key="o" size={14} />],
    ['Snapshot now', 'Take an on-demand backup', snapshot, <HardDrive key="s" size={14} />],
    ['Run pending migrations', 'Create any tables missing from the current schema', () => maint('schema_sync', 'Run pending migrations', false), <Database key="m" size={14} />],
  ]
  return <div className="space-y-2">
    <Strip items={[
      { l: 'Engine', v: db.engine, kpi: 'tenant.db_engine', kpiQuery: kq }, { l: 'Database', v: <span className="text-sm">{db.database}</span>, kpi: 'tenant.db', kpiQuery: kq }, { l: 'Server', v: db.server || '—', d: db.server_ip || '', kpi: 'tenant.db_server', kpiQuery: kq },
      { l: 'Size', v: mb(db.size_mb), d: `${db.table_count} tables`, kpi: 'tenant.db_size', kpiQuery: kq }, { l: 'Connections', v: `${db.connections} / ${db.max_connections}`, d: 'server max', kpi: 'tenant.db_connections', kpiQuery: kq },
      { l: 'Replicas', v: db.replication.startsWith('No') ? 'None' : 'Configured', kpi: 'tenant.db_replicas', kpiQuery: kq }, { l: 'Last backup', v: db.last_backup_at ? fd(db.last_backup_at) : 'Never', c: db.last_backup_at ? C.ok : C.wa, d: db.last_backup_at ? '' : 'no snapshot', kpi: 'tenant.last_backup', kpiQuery: kq },
    ]} />
    <div className="grid gap-2 xl:grid-cols-2">
      <Panel title="Connection & isolation"><Kv rows={[
        ['Host', `${db.host}:${db.port}`], ['Pooler', db.pool], ['Isolation', db.isolation], ['Encryption', `TLS ${db.ssl === 'YES' ? 'enabled' : 'disabled'} · at rest ${db.encryption_at_rest}`],
        ['Replication', db.replication], ['Character set', db.charset], ['Data / index', `${mb(db.data_mb)} / ${mb(db.index_mb)}`], ['Reclaimable', mb(db.free_mb)],
      ]} />{db.restored_databases.length > 0 && <Note info className="mt-2">Restored copies on this server: {db.restored_databases.join(', ')}</Note>}</Panel>
      <Panel title="Maintenance"><div className="grid gap-1.5 sm:grid-cols-2">{actions.map(([t, d, fn, icon]) => <button key={t} type="button" disabled={!canManage} onClick={fn} className="rounded-md border p-2 text-left disabled:opacity-50" style={{ borderColor: C.ln, background: C.sf }}><b className="flex items-center gap-1.5">{icon}{t}</b><small className="text-xs" style={{ color: C.mu }}>{d}</small></button>)}</div></Panel>
    </div>
    <Panel title={`Table inventory · ${db.table_count} tables`} flush>
      <Table head={['Table', { t: 'Rows', r: true }, { t: 'Data MB', r: true }, { t: 'Index MB', r: true }, { t: 'Reclaimable MB', r: true }, 'Engine', 'Last updated']} minWidth={760}>
        {db.tables.map(t => <tr key={t.name}><td><code className="text-xs">{t.name}</code></td><td className="text-right">{num(t.rows)}</td><td className="text-right">{t.data_mb.toFixed(2)}</td><td className="text-right">{t.index_mb.toFixed(2)}</td><td className="text-right" style={{ color: t.free_mb > 5 ? C.wa : undefined }}>{t.free_mb.toFixed(2)}</td><td>{t.engine}</td><td>{fdt(t.updated_at)}</td></tr>)}
        <tr className="font-semibold"><td>Total</td><td className="text-right">{num(db.tables.reduce((a, t) => a + t.rows, 0))}</td><td className="text-right">{db.data_mb.toFixed(2)}</td><td className="text-right">{db.index_mb.toFixed(2)}</td><td className="text-right">{db.free_mb.toFixed(2)}</td><td colSpan={2} /></tr>
      </Table>
    </Panel>
    {canManage && <Panel title="SQL console · read-only" act={<small className="text-xs font-normal" style={{ color: C.mu }}>SELECT / SHOW / DESCRIBE / EXPLAIN · 200 rows · 10 s · audited</small>}>
      <textarea className="w-full rounded-md border p-2 font-mono text-xs" rows={3} style={{ background: '#0E1621', color: '#D3E4F6', borderColor: '#2A3A4D' }} value={sql} onChange={e => setSql(e.target.value)} spellCheck={false} aria-label="SQL statement" />
      <div className="mt-1.5 flex items-center gap-2"><Btn p s onClick={() => void runQuery()} disabled={running}><Play size={12} /> {running ? 'Running…' : 'Run'}</Btn>{result && <small className="text-xs" style={{ color: C.mu }}>{result.rows.length} row(s){result.truncated ? ' (truncated)' : ''} · {result.ms} ms</small>}</div>
      {queryError && <Note className="mt-2">{queryError}</Note>}
      {result && <div className="mt-2 max-h-72 overflow-auto rounded-md border" style={{ borderColor: C.ln }}><Table head={result.columns} minWidth={400}>{result.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="whitespace-nowrap text-xs">{v ?? <span style={{ color: C.mu }}>NULL</span>}</td>)}</tr>)}</Table></div>}
    </Panel>}
    <Panel title="Slow queries" flush act={<small className="text-xs font-normal" style={{ color: C.mu }}>MariaDB slow query log</small>}>
      {!slow.data ? <Loading /> : !slow.data.available ? <Empty>{slow.data.reason || 'Slow query log unavailable'}</Empty> : !slow.data.queries.length ? <Empty>No slow queries recorded for this database.</Empty>
        : <Table head={['Statement', 'Duration', { t: 'Rows examined', r: true }, { t: 'Rows sent', r: true }, 'Started']} minWidth={700}>{slow.data.queries.map((q, i) => <tr key={i}><td className="max-w-md"><code className="break-all text-xs">{q.sql}</code></td><td>{q.duration}</td><td className="text-right">{num(q.rows_examined)}</td><td className="text-right">{num(q.rows_sent)}</td><td className="whitespace-nowrap">{q.started_at}</td></tr>)}</Table>}
    </Panel>
  </div>
}

function MonitoringTab({ id }: Ctx) {
  const { data, error, load } = useLoad<TenantMonitoring>(() => platformApi.tenantMonitoring(id), [id])
  const logs = useLoad<TenantAuditEntry[]>(() => platformApi.getTenantAuditLogs(id, 7), [id])
  useEffect(() => { const t = window.setInterval(() => { if (!document.hidden) void load() }, 5000); return () => window.clearInterval(t) }, [load])
  if (error) return <Note>{error}</Note>
  if (!data) return <Loading />
  const t = data.traffic
  const series = t.series.map(p => ({ label: p.seconds_ago ? `-${p.seconds_ago}s` : 'now', v: p.requests_per_min }))
  const tracked = data.availability.filter(d => d.percent != null)
  const kq = { tenant_id: id }
  return <div className="space-y-2">
    <Strip items={[
      { l: 'Requests / min', v: t.requests_per_minute, d: 'this tenant', kpi: 'tenant.requests', kpiQuery: kq }, { l: 'p95 latency', v: t.p95_ms != null ? `${Math.round(t.p95_ms)} ms` : '—', d: `SLO ${data.targets.p95_ms} ms`, kpi: 'tenant.p95', kpiQuery: kq },
      { l: 'Error rate', v: `${t.error_rate.toFixed(2)}%`, kpi: 'tenant.error_rate', kpiQuery: kq }, { l: 'Active sessions', v: num(data.active_sessions), kpi: 'tenant.sessions', kpiQuery: kq },
      { l: 'Uptime · 30d', v: data.uptime_30d != null ? `${data.uptime_30d.toFixed(2)}%` : '—', d: data.server || '', c: data.uptime_30d != null && data.uptime_30d < data.targets.sla_percent ? C.ba : C.ok, kpi: 'tenant.uptime', kpiQuery: kq },
      { l: 'Apdex', v: t.apdex != null ? t.apdex.toFixed(2) : '—', d: `T = ${data.targets.p95_ms} ms`, kpi: 'tenant.apdex', kpiQuery: kq },
    ]} />
    <div className="grid gap-2 xl:grid-cols-2">
      <Panel title="Requests (live)" act={<small className="text-xs font-normal" style={{ color: C.mu }}>{t.requests} requests · last {t.window_seconds / 60} min</small>}>
        {series.length ? <LineChart h={170} labels={series.map((p, i) => i % 8 === 0 ? p.label : '')} series={[{ n: 'req/min', c: PAL[0], v: series.map(p => p.v) }]} /> : <Empty>No requests in this window</Empty>}
      </Panel>
      <Panel title="Availability · last 30 days">
        <div className="flex flex-wrap gap-0.5">{data.availability.map(d => <span key={d.day_start} title={`${fd(d.day_start)} · ${d.percent == null ? 'not tracked' : `${d.percent}%`}`} className="h-[30px] w-4 rounded-sm" style={{ background: d.percent == null ? C.ln2 : d.percent >= data.targets.sla_percent ? C.ok : d.percent >= 95 ? C.wa : C.ba }} />)}</div>
        <p className="mt-2 text-xs" style={{ color: C.mu }}>{tracked.length ? `${tracked.filter(d => (d.percent ?? 0) < data.targets.sla_percent).length} degraded day(s) of ${tracked.length} tracked on ${data.server}. SLA ${data.targets.sla_percent}%.` : 'Uptime tracking has not recorded any days yet.'}</p>
      </Panel>
    </div>
    <Panel title="Recent tenant logs" flush act={<Link to={`/platform/tenants/${id}/audit`} className="text-xs font-normal" style={{ color: C.ac }}>All activity →</Link>}>
      {!logs.data ? <Loading /> : !logs.data.length ? <Empty>No recent logs</Empty> : logs.data.map(l => <div key={l.id} className="flex items-center gap-2 border-b px-2.5 py-1.5 font-mono text-xs last:border-0" style={{ borderColor: C.ln2 }}><Pill t="inf">{l.action}</Pill><span style={{ color: C.mu }}>{fdt(l.created_at)}</span><span>{l.module}</span><span className="flex-1 truncate">· {l.description || ''}</span><span style={{ color: C.mu }}>{l.user_name || ''}</span></div>)}
    </Panel>
  </div>
}

function BackupsTab({ id, ov, canManage, ask }: Ctx & { ask: (c: Confirm) => void }) {
  const { success, error: showError } = useToast()
  const { data, error, load } = useLoad<TenantBackupRow[]>(() => platformApi.tenantBackups(id), [id])
  const dbInfo = useLoad<TenantDatabase>(() => platformApi.tenantDatabase(id), [id])
  if (error) return <Note>{error}</Note>
  if (!data) return <Loading />
  const done = data.filter(b => b.status === 'completed')
  const kq = { tenant_id: id }
  const scheduled = data.find(b => b.frequency && b.next_run_at)
  const download = async (b: TenantBackupRow) => { try { downloadBlob((await platformApi.downloadBackup(b.id)).data as Blob, `${ov.slug}-backup-${b.id}.sql`) } catch (err) { showError(errMsg(err, 'Download failed')) } }
  const restore = (b: TenantBackupRow) => ask({
    title: `Restore ${ov.name}`, label: 'Start restore', typed: ov.slug,
    body: <p>Restore from <b>{b.name} ({fdt(b.completed_at)})</b> into a new database <b>{ov.db_name}_restore_…</b> on the same server. The live database stays untouched; switching to the restored copy is a manual DBA step after you verify it.</p>,
    run: async () => { const { data: r } = await platformApi.restoreBackup(b.id); success(r.message); await dbInfo.load() },
  })
  return <div className="space-y-2">
    <Strip items={[
      { l: 'Last snapshot', v: done[0] ? fd(done[0].completed_at) : 'Never', c: done[0] ? C.ok : C.wa, kpi: 'tenant.last_backup', kpiQuery: kq },
      { l: 'Schedule', v: scheduled ? cap(scheduled.frequency) : 'Manual', d: scheduled ? `next ${fd(scheduled.next_run_at)}` : '', kpi: 'tenant.backup_schedule', kpiQuery: kq },
      { l: 'Snapshots', v: done.length, d: `${data.filter(b => b.status === 'failed').length} failed`, kpi: 'tenant.backups', kpiQuery: kq },
      { l: 'Total size', v: mb(done.reduce((a, b) => a + (b.size_mb || 0), 0)), kpi: 'tenant.backup_size', kpiQuery: kq },
      { l: 'Restored copies', v: dbInfo.data?.restored_databases.length ?? '—', kpi: 'tenant.restored', kpiQuery: kq },
    ]} />
    <Panel title="Snapshots" flush act={canManage ? <Btn s p onClick={() => ask({ title: 'Snapshot now', label: 'Run', body: <p>Take an on-demand backup of <code>{ov.db_name}</code> now?</p>, run: async () => { await platformApi.createTenantBackup(id); success('Snapshot completed'); await load() } })}><HardDrive size={12} /> Snapshot now</Btn> : undefined}>
      {!data.length ? <Empty>No snapshots yet. Use “Snapshot now” or schedule backups in Backups.</Empty> : <Table head={['Snapshot', 'Taken', 'Type', { t: 'Size', r: true }, 'Status', '']} minWidth={680}>
        {data.map(b => <tr key={b.id}><td>{b.name} <small style={{ color: C.mu }}>#{b.id}</small></td><td>{fdt(b.completed_at || b.created_at)}</td><td>{b.frequency ? `Scheduled · ${b.frequency}` : 'On demand'}</td><td className="text-right">{mb(b.size_mb)}</td>
          <td><Pill t={statusTone(b.status)}>{cap(b.status)}</Pill>{b.status === 'completed' && !b.available && <> <Pill t="wa">File missing</Pill></>}</td>
          <td className="whitespace-nowrap text-right">{b.available && <>{canManage && <Btn s onClick={() => restore(b)}>Restore…</Btn>} <Btn s onClick={() => void download(b)} title="Download"><Download size={12} /></Btn></>}</td></tr>)}
      </Table>}
    </Panel>
    <Panel title="Recovery">
      <p className="text-xs" style={{ color: C.mu }}>Restores always go to a <b>new database</b> first so you can verify before switching. Backups are full SQL dumps of the tenant database; point-in-time recovery needs MariaDB binary logs, which this deployment does not keep.</p>
      {dbInfo.data && dbInfo.data.restored_databases.length > 0 && <Note info className="mt-2">Restored copies: {dbInfo.data.restored_databases.join(', ')}</Note>}
    </Panel>
  </div>
}

function ModulesTab({ id, ov, canManage }: Ctx) {
  const { success, error: showError } = useToast()
  const { data, error, setData } = useLoad<TenantFeaturesResponse>(() => platformApi.getTenantFeatures(id), [id])
  const [saving, setSaving] = useState<number | null>(null)
  if (error) return <Note>{error}</Note>
  if (!data) return <Loading />
  const toggle = async (featureId: number, on: boolean) => {
    const ids = on ? [...data.feature_ids, featureId] : data.feature_ids.filter(x => x !== featureId)
    setSaving(featureId)
    try {
      await platformApi.updateTenantFeatures(id, ids)
      setData({ ...data, feature_ids: ids, features: data.features.map(f => f.id === featureId ? { ...f, enabled: on } : f) })
      success(`${on ? 'Enabled' : 'Disabled'} ${data.features.find(f => f.id === featureId)?.name} for ${ov.slug}`)
    } catch (err) { showError(errMsg(err, 'Unable to update modules')) } finally { setSaving(null) }
  }
  return <div className="space-y-2">
    <Note info>Switch modules on or off for this tenant – the tenant’s sidebar updates on their next page load.</Note>
    <Panel title="Module entitlements" act={<small className="text-xs font-normal" style={{ color: C.mu }}>{data.feature_ids.length} of {data.features.length} enabled</small>}>
      <div className="grid gap-x-4 sm:grid-cols-2 xl:grid-cols-3">{data.features.map(f => <div key={f.id} className="flex items-center gap-2 border-b py-1.5" style={{ borderColor: C.ln2 }}><Switch on={data.feature_ids.includes(f.id)} disabled={!canManage || saving === f.id} onChange={v => void toggle(f.id, v)} label={f.name} /><span className="flex-1">{f.name}</span>{f.module && <small className="text-xs" style={{ color: C.mu }}>{f.module}</small>}</div>)}</div>
    </Panel>
  </div>
}

export function UsersTable({ users, onChanged, canManage, showCompany }: { users: TenantUserRow[]; onChanged: () => Promise<void>; canManage: boolean; showCompany?: boolean }) {
  const { success, error: showError } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key)
    try { await fn(); success(msg); await onChanged() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy(null) }
  }
  if (!users.length) return <Empty>No users</Empty>
  return <Table head={['Name', 'Email', ...(showCompany ? ['Company'] : []), 'Role', 'MFA', 'Last active', 'Status', '']} minWidth={860}>
    {users.map(u => <tr key={`${u.tenant_id}-${u.id}`}>
      <td className="font-semibold">{u.name}</td><td>{u.email}</td>{showCompany && <td>{u.company}</td>}<td><Pill t="ac">{u.role}</Pill></td>
      <td>{u.mfa ? <Pill t="ok">OTP</Pill> : <Pill t="mu">Off</Pill>}</td><td>{fdt(u.last_active || u.last_login)}</td>
      <td><Pill t={u.is_active ? 'ok' : 'ba'}>{u.is_active ? 'Active' : 'Suspended'}</Pill></td>
      <td className="whitespace-nowrap text-right">{canManage && <>
        <Btn s onClick={() => void act(`s${u.id}`, () => platformApi.signOutTenantUser(u.tenant_id, u.id), `${u.name} signed out`)} disabled={busy !== null}>Sign out</Btn>{' '}
        {u.is_active ? <Btn s d onClick={() => void act(`a${u.id}`, () => platformApi.setTenantUserStatus(u.tenant_id, u.id, false), `${u.name} suspended`)} disabled={busy !== null}>Suspend</Btn>
          : <Btn s onClick={() => void act(`a${u.id}`, () => platformApi.setTenantUserStatus(u.tenant_id, u.id, true), `${u.name} reinstated`)} disabled={busy !== null}>Reinstate</Btn>}
      </>}</td>
    </tr>)}
  </Table>
}

function UsersTab({ id, ov, canManage, ask }: Ctx & { ask: (c: Confirm) => void }) {
  const { success } = useToast()
  const { data, error, load } = useLoad<TenantUserRow[]>(() => platformApi.tenantUsers(id), [id])
  return <Panel title={`Users (${data?.length ?? '…'})`} flush act={canManage ? <Btn s d onClick={() => ask({ title: 'Force sign-out all users', label: 'Sign out everyone', danger: true, body: <p>All active sessions for {ov.name} are invalidated.</p>, run: async () => { await platformApi.forceLogoutTenant(id, 'Forced logout by platform admin'); success('All sessions invalidated') } })}>Force sign-out all</Btn> : undefined}>
    {error ? <Note>{error}</Note> : !data ? <Loading /> : <UsersTable users={data} onChanged={load} canManage={canManage} />}
  </Panel>
}

// Editable tenant settings (formerly the separate Configure tenant page): each panel opens its own edit dialog.
type EditField = { key: keyof PlatformTenant | 'smtp_password'; label: string; type?: 'text' | 'email' | 'number' | 'date' | 'password' | 'textarea' | 'check'; hint?: string; wide?: boolean }
const toInput = (t: PlatformTenant, f: EditField): string | boolean => {
  const v = (t as unknown as Record<string, unknown>)[f.key]
  if (f.type === 'check') return Boolean(v)
  if (f.type === 'date') return v ? String(v).slice(0, 10) : ''
  return v == null ? '' : String(v)
}
function EditTenantModal({ t, title, fields, onClose, onSaved, extra }: { t: PlatformTenant; title: string; fields: EditField[]; onClose: () => void; onSaved: () => Promise<void>; extra?: (form: Record<string, string | boolean>) => ReactNode }) {
  const { success, error: showError } = useToast()
  const [form, setForm] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map(f => [f.key, f.key === 'smtp_password' ? '' : toInput(t, f)])))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const payload: Record<string, unknown> = {}
    for (const f of fields) {
      const v = form[f.key]
      if (f.key === 'smtp_password') { if (v) payload[f.key] = v; continue }  // blank keeps the stored password
      payload[f.key] = f.type === 'check' ? v : f.type === 'number' ? (v === '' ? null : Number(v)) : (String(v).trim() || null)
    }
    if ('name' in payload && !payload.name) return showError('Tenant name is required')
    setBusy(true)
    try { await platformApi.updateTenant(t.id, payload); success(`${title} saved`); await onSaved(); onClose() }
    catch (err) { showError(errMsg(err, `Unable to save ${title.toLowerCase()}`)) } finally { setBusy(false) }
  }
  return <BwModal title={title} width={640} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
    <div className="grid gap-2.5 sm:grid-cols-2">{fields.map(f => f.type === 'check'
      ? <label key={f.key} className="flex items-center gap-2 self-end py-1.5"><Switch on={Boolean(form[f.key])} onChange={v => setForm(x => ({ ...x, [f.key]: v }))} label={f.label} />{f.label}</label>
      : <div key={f.key} className={f.wide || f.type === 'textarea' ? 'sm:col-span-2' : ''}><Field label={f.label}>{f.type === 'textarea'
        ? <textarea className={inputCls} style={{ ...inputStyle, height: 'auto' }} rows={3} value={String(form[f.key])} onChange={e => setForm(x => ({ ...x, [f.key]: e.target.value }))} />
        : <input type={f.type || 'text'} className={inputCls} style={inputStyle} value={String(form[f.key])} placeholder={f.key === 'smtp_password' ? 'Leave blank to keep the current password' : undefined} autoComplete={f.type === 'password' ? 'new-password' : undefined} onChange={e => setForm(x => ({ ...x, [f.key]: e.target.value }))} />}</Field>
        {f.hint && <small className="mt-0.5 block text-[11px]" style={{ color: C.mu }}>{f.hint}</small>}</div>)}</div>
    {extra?.(form)}
  </BwModal>
}

function SmtpTest({ id, form }: { id: number; form: Record<string, string | boolean> }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null)
  const run = async () => {
    setBusy(true); setResult(null)
    try {
      const { data } = await platformApi.testTenantSmtp(id, { host: String(form.smtp_host).trim(), port: Number(form.smtp_port), user: String(form.smtp_user || '') || undefined,
        password: String(form.smtp_password || '') || undefined, use_tls: Boolean(form.smtp_use_tls), use_ssl: Boolean(form.smtp_use_ssl) })
      setResult(data)
    } catch (err) { setResult({ success: false, message: errMsg(err, 'Test failed') }) } finally { setBusy(false) }
  }
  return <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t pt-2.5" style={{ borderColor: C.ln2 }}>
    <Btn disabled={busy || !form.smtp_host || !form.smtp_port} onClick={() => void run()}>{busy ? 'Testing…' : 'Test SMTP connection'}</Btn>
    {result && <Pill t={result.success ? 'ok' : 'ba'}>{result.message}</Pill>}
    <small className="w-full text-[11px]" style={{ color: C.mu }}>With the password left blank, the test uses the stored password. Leave the host empty to send through the platform mail server.</small>
  </div>
}

const PROFILE_FIELDS: EditField[] = [{ key: 'name', label: 'Tenant name', wide: true }, { key: 'notes', label: 'Internal notes', type: 'textarea' }]
const SMTP_FIELDS: EditField[] = [
  { key: 'smtp_host', label: 'SMTP host', hint: 'Empty = platform mail server' }, { key: 'smtp_port', label: 'SMTP port', type: 'number' },
  { key: 'smtp_user', label: 'SMTP user' }, { key: 'smtp_password', label: 'SMTP password', type: 'password' },
  { key: 'from_email', label: 'From e-mail', type: 'email' }, { key: 'company_mail', label: 'Company e-mail', type: 'email' },
  { key: 'smtp_use_tls', label: 'Use TLS (STARTTLS)', type: 'check' }, { key: 'smtp_use_ssl', label: 'Use SSL', type: 'check' },
]
const ADDRESS_FIELDS: EditField[] = [
  { key: 'street_address', label: 'Street address', wide: true }, { key: 'area_locality', label: 'Area / locality' }, { key: 'city_district', label: 'City / district' },
  { key: 'state', label: 'State' }, { key: 'pincode', label: 'Pincode' }, { key: 'country', label: 'Country' },
]
const SESSION_FIELDS: EditField[] = [
  { key: 'normal_login_expiry_minutes', label: 'Sign-in lasts (minutes)', type: 'number', hint: 'Without “Remember me”' },
  { key: 'remember_me_expiry_minutes', label: 'Remember-me lasts (minutes)', type: 'number' },
]
type ConfigEdit = 'profile' | 'smtp' | 'address' | 'session'
const CONFIG_EDITS: Record<ConfigEdit, { title: string; fields: EditField[] }> = {
  profile: { title: 'Tenant profile', fields: PROFILE_FIELDS }, smtp: { title: 'E-mail & SMTP', fields: SMTP_FIELDS },
  address: { title: 'Address', fields: ADDRESS_FIELDS }, session: { title: 'Sign-in sessions', fields: SESSION_FIELDS },
}

function ConfigurationTab({ id, reload, canManage }: Ctx) {
  const config = useLoad<TenantConfiguration>(() => platformApi.tenantConfiguration(id), [id])
  const tenant = useLoad<PlatformTenant>(() => platformApi.getTenant(id), [id])
  const [editing, setEditing] = useState<ConfigEdit | null>(null)
  if (config.error || tenant.error) return <Note>{config.error || tenant.error}</Note>
  if (!config.data || !tenant.data) return <Loading />
  const data = config.data, t = tenant.data, i = data.identity
  const saved = async () => { await Promise.all([tenant.load(), config.load(), reload()]) }
  const edit = (k: ConfigEdit) => canManage ? <Btn s onClick={() => setEditing(k)}>Edit</Btn> : undefined
  return <div className="grid gap-2 xl:grid-cols-2">
    {editing && <EditTenantModal t={t} {...CONFIG_EDITS[editing]} onClose={() => setEditing(null)} onSaved={saved} extra={editing === 'smtp' ? form => <SmtpTest id={id} form={form} /> : undefined} />}
    <Panel title="Tenant profile" act={edit('profile')}><Kv rows={[
      ['Tenant name', t.name], ['Workspace slug', <code key="s" className="text-xs">{t.slug}</code>], ['Sub-domain', i.subdomain], ['Administrator', `${t.admin_name} · ${t.admin_email}`],
      ['Internal notes', t.notes || '—'],
    ]} /></Panel>
    <Panel title="E-mail & SMTP" act={edit('smtp')}><Kv rows={[
      ['SMTP server', t.smtp_host ? `${t.smtp_host}:${t.smtp_port ?? ''}` : 'Platform default'], ['SMTP user', t.smtp_user || '—'],
      ['Encryption', t.smtp_host ? [t.smtp_use_tls && 'TLS', t.smtp_use_ssl && 'SSL'].filter(Boolean).join(' + ') || 'None' : '—'],
      ['From e-mail', t.from_email || '—'], ['Company e-mail', t.company_mail || '—'],
    ]} /></Panel>
    <Panel title="Address" act={edit('address')}><Kv rows={[
      ['Street', t.street_address || '—'], ['Area / locality', t.area_locality || '—'], ['City / district', t.city_district || '—'],
      ['State', t.state || '—'], ['Pincode', t.pincode || '—'], ['Country', t.country || '—'],
    ]} /></Panel>
    <Panel title="Sign-in sessions" act={edit('session')}><Kv rows={[
      ['Sign-in lasts', `${num(t.normal_login_expiry_minutes)} min`], ['Remember-me lasts', `${num(t.remember_me_expiry_minutes)} min`],
      ['Idle timeout & password policy', <Link key="s" to={`/platform/tenants/${id}?tab=Security`} style={{ color: C.ac }}>Security tab →</Link>],
    ]} /></Panel>
    <Panel title="Branding & sign-in protection"><Kv rows={[
      ['Brand colour', i.primary_color ? <span key="c" className="inline-flex items-center gap-1"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: String(i.primary_color) }} />{i.primary_color}</span> : '—'],
      ['Logo', i.logo_url ? 'Uploaded' : 'Default'], ['OTP verification', cap(String(i.otp_mode))], ['CAPTCHA', cap(String(i.captcha_mode))],
    ]} /></Panel>
    <Panel title="Configuration footprint" flush act={<Link to="/platform/feature-matrix" className="text-xs font-normal" style={{ color: C.ac }}>Feature matrix →</Link>}>
      {!data.counts ? <Empty>Tenant database is unreachable.</Empty> : <Table head={['Item', { t: 'Count', r: true }]} minWidth={300}>{Object.entries(data.counts).map(([k, v]) => <tr key={k}><td>{k}</td><td className="text-right font-semibold">{num(v)}</td></tr>)}</Table>}
    </Panel>
  </div>
}

function LimitsTab({ id, ov, reload, canManage }: Ctx) {
  const { success, error: showError } = useToast()
  const meters = useLoad<{ meters: TenantMeter[] }>(() => platformApi.tenantMetering(id), [id])
  const [form, setForm] = useState({ max_users: String(ov.max_users), storage_limit_mb: String(ov.storage_limit_mb) })
  const save = async () => {
    try { await platformApi.updateTenant(id, { max_users: Number(form.max_users), storage_limit_mb: Number(form.storage_limit_mb) }); success(`Limits saved for ${ov.name}`); await reload(); await meters.load() } catch (err) { showError(errMsg(err, 'Unable to save limits')) }
  }
  return <div className="grid gap-2 xl:grid-cols-2">
    <Panel title="Quotas & limits"><div className="grid gap-2.5 sm:grid-cols-2">
      <Field label={`Maximum users${ov.plan ? ` (plan ${ov.plan.name}: ${ov.plan.max_users})` : ''}`}><input type="number" min={1} className={inputCls} style={inputStyle} value={form.max_users} disabled={!canManage} onChange={e => setForm(f => ({ ...f, max_users: e.target.value }))} /></Field>
      <Field label="Storage (MB)"><input type="number" min={1} className={inputCls} style={inputStyle} value={form.storage_limit_mb} disabled={!canManage} onChange={e => setForm(f => ({ ...f, storage_limit_mb: e.target.value }))} /></Field>
    </div>{canManage && <div className="mt-2.5"><Btn p onClick={() => void save()}>Save limits</Btn></div>}</Panel>
    <Panel title="Metering · current usage" flush>
      {!meters.data ? <Loading /> : <Table head={['Meter', { t: 'Used', r: true }, { t: 'Included', r: true }, { t: 'Overage', r: true }]} minWidth={420}>{meters.data.meters.map(m => <tr key={m.meter}><td>{m.meter}</td><td className="text-right">{m.used == null ? '—' : `${num(m.used)} ${m.unit === 'MB' ? 'MB' : ''}`}</td><td className="text-right">{m.included == null ? '—' : num(m.included)}</td><td className="text-right" style={{ color: m.overage ? C.ba : undefined }}>{num(m.overage)}</td></tr>)}</Table>}
    </Panel>
  </div>
}

function BillingTab({ id, ov, reload, canManage, ask }: Ctx & { ask: (c: Confirm) => void }) {
  const { success } = useToast()
  const tenant = useLoad<PlatformTenant>(() => platformApi.getTenant(id), [id])
  const plans = useLoad<PlatformPlan[]>(() => platformApi.listPlans(), [])
  const history = useLoad<TenantPlanHistoryEntry[]>(() => platformApi.getTenantPlanHistory(id), [id])
  const t = tenant.data
  const [editBilling, setEditBilling] = useState(false)
  const changePlan = (planId: number) => {
    const plan = plans.data?.find(p => p.id === planId)
    if (!plan) return
    ask({ title: 'Change plan', label: 'Change plan', body: <p>Move {ov.name} to <b>{plan.name}</b> ({inr(plan.price_monthly)} / month)?</p>, run: async () => { await platformApi.updateTenant(id, { plan_id: planId }); success(`Plan changed to ${plan.name}`); await Promise.all([reload(), tenant.load(), history.load()]) } })
  }
  const setBilling = async (status: string) => { await platformApi.updateTenant(id, { billing_status: status }); success('Billing status updated'); await tenant.load() }
  return <div className="grid gap-2 xl:grid-cols-2">
    <Panel title="Subscription">{!t || !plans.data ? <Loading /> : <div className="grid gap-2.5 sm:grid-cols-2">
      <Field label="Plan"><select className={inputCls} style={inputStyle} value={t.plan_id ?? ''} disabled={!canManage} onChange={e => changePlan(Number(e.target.value))}><option value="" disabled>— Select —</option>{plans.data.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      <Field label="Billing status"><select className={inputCls} style={inputStyle} value={t.billing_status} disabled={!canManage} onChange={e => void setBilling(e.target.value)}>{['trial', 'active', 'past_due', 'cancelled', 'free'].map(s => <option key={s} value={s}>{cap(s)}</option>)}</select></Field>
      <Field label="Price / month"><input className={inputCls} style={inputStyle} disabled value={ov.plan ? inr(ov.plan.price_monthly) : '—'} /></Field>
      <Field label={t.status === 'trial' ? 'Trial ends' : 'Next renewal'}><input className={inputCls} style={inputStyle} disabled value={fd(t.status === 'trial' ? t.trial_ends_at : t.subscription_end_date)} /></Field>
      <div className="sm:col-span-2 text-xs" style={{ color: C.mu }}>MRR counted for this tenant: <b style={{ color: C.tx }}>{inr(ov.mrr)}</b>{t.billing_email ? ` · billing contact ${t.billing_email}` : ''}</div>
    </div>}</Panel>
    {t && <Panel title="Billing contact" act={canManage ? <Btn s onClick={() => setEditBilling(true)}>Edit</Btn> : undefined}><Kv rows={[
      ['Billing e-mail', t.billing_email || <span key="b" style={{ color: C.mu }}>Admin e-mail ({t.admin_email})</span>], ['Subscription ends', t.subscription_end_date ? fd(t.subscription_end_date) : 'Ongoing'],
      ['Billing notes', t.billing_notes || '—'],
    ]} /></Panel>}
    {t && editBilling && <EditTenantModal t={t} title="Billing contact" onClose={() => setEditBilling(false)} onSaved={async () => { await Promise.all([tenant.load(), reload()]) }} fields={[
      { key: 'billing_email', label: 'Billing e-mail', type: 'email', hint: 'Overrides the admin e-mail for billing notices' }, { key: 'subscription_end_date', label: 'Subscription end date', type: 'date', hint: 'Leave blank if ongoing' },
      { key: 'billing_notes', label: 'Billing notes', type: 'textarea' }]} />}
    <Panel title="Plan history" flush>
      {!history.data ? <Loading /> : !history.data.length ? <Empty>No plan changes recorded</Empty> : <Table head={['Date', 'From', 'To', 'Changed by', 'Note']} minWidth={520}>{history.data.map(h => <tr key={h.id}><td>{fdt(h.created_at)}</td><td>{h.old_plan_name || '—'}</td><td className="font-semibold">{h.new_plan_name || '—'}</td><td>{h.changed_by}</td><td>{h.note || ''}</td></tr>)}</Table>}
    </Panel>
  </div>
}

function SecurityTab({ id, canManage }: Ctx) {
  const { success, error: showError } = useToast()
  const { data, error, setData } = useLoad<TenantSecurity>(() => platformApi.tenantSecurity(id), [id])
  if (error) return <Note>{error}</Note>
  if (!data) return <Loading />
  const save = async (patch: Partial<TenantSecurity>) => {
    try { const { data: next } = await platformApi.updateTenantSecurity(id, patch); setData({ ...data, ...next }); success('Security settings saved') } catch (err) { showError(errMsg(err, 'Unable to save')) }
  }
  const row = (label: string, hint: string, control: ReactNode) => <div className="flex items-center gap-2 border-b px-2.5 py-2 last:border-0" style={{ borderColor: C.ln2 }}><span className="flex-1"><b>{label}</b><br /><small className="text-xs" style={{ color: C.mu }}>{hint}</small></span>{control}</div>
  const select = (key: 'otp_mode' | 'captcha_mode', options: string[]) => <select className={`${inputCls} !w-44`} style={inputStyle} value={data[key]} disabled={!canManage} onChange={e => void save({ [key]: e.target.value })}>{options.map(o => <option key={o} value={o}>{cap(o)}</option>)}</select>
  return <Panel title="Security & identity" flush>
    {row('OTP verification for sign-in', 'Email one-time password', select('otp_mode', data.otp_modes || []))}
    {row('CAPTCHA on sign-in', 'Bot protection on the login page', select('captcha_mode', data.captcha_modes || []))}
    {row('Force password change on first login', 'New users must set their own password', <Switch on={data.force_password_change_on_first_login} disabled={!canManage} onChange={v => void save({ force_password_change_on_first_login: v })} label="Force password change" />)}
    {row('New device login alert', 'Email the user when they sign in from a new device', <Switch on={data.new_device_login_alert_enabled} disabled={!canManage} onChange={v => void save({ new_device_login_alert_enabled: v })} label="New device alert" />)}
    {row('Self-service password reset', 'Forgot-password link on the login page', <Switch on={data.forgot_password_enabled} disabled={!canManage} onChange={v => void save({ forgot_password_enabled: v })} label="Forgot password" />)}
    {row('Password expiry', `Passwords expire after ${data.password_expiry_days} days`, <span className="flex items-center gap-2"><input type="number" min={1} className={`${inputCls} !w-20`} style={inputStyle} defaultValue={data.password_expiry_days} disabled={!canManage} onBlur={e => Number(e.target.value) !== data.password_expiry_days && void save({ password_expiry_days: Number(e.target.value) })} aria-label="Password expiry days" /><Switch on={data.password_expiry_enabled} disabled={!canManage} onChange={v => void save({ password_expiry_enabled: v })} label="Password expiry" /></span>)}
    {row('Session timeout', 'Sign out after this many minutes of inactivity', <input type="number" min={1} className={`${inputCls} !w-20`} style={inputStyle} defaultValue={data.inactivity_timeout_minutes} disabled={!canManage} onBlur={e => Number(e.target.value) !== data.inactivity_timeout_minutes && void save({ inactivity_timeout_minutes: Number(e.target.value) })} aria-label="Session timeout minutes" />)}
  </Panel>
}

function HierarchyTab({ id, ov, reload, canManage }: Ctx) {
  const { success, error: showError } = useToast()
  const groups = useLoad<{ tenants: unknown[]; groups: HierarchyGroupRow[] }>(() => platformApi.tenantHierarchy(), [])
  const row = useLoad(() => platformApi.tenantHierarchy().then(r => ({ data: r.data.tenants.find(t => t.id === id) || null })), [id])
  const [pick, setPick] = useState('')
  const [visibility, setVisibility] = useState<ParentVisibility>('full')
  const t = row.data
  const save = async (patch: Parameters<typeof platformApi.setTenantHierarchy>[1], msg: string) => {
    try { await platformApi.setTenantHierarchy(id, patch); success(msg); await Promise.all([row.load(), reload()]) } catch (err) { showError(errMsg(err, 'Unable to update hierarchy')) }
  }
  if (!t || !groups.data) return <Loading />
  if (t.parent_group_id) return <div className="space-y-2">
    <Note info>Parent group <b>{t.parent_name}</b> can see this company according to its parent visibility below. Sibling companies cannot see each other – every company keeps its own database.</Note>
    <Panel title="Parent group" act={<Link to={`/platform/tenant-groups/${t.parent_group_id}`} className="text-xs font-normal" style={{ color: C.ac }}>Open group →</Link>}><div className="grid gap-2.5 sm:grid-cols-2">
      <Field label="Parent group"><select className={inputCls} style={inputStyle} value={t.parent_group_id} disabled={!canManage} onChange={e => void save({ parent_group_id: Number(e.target.value) }, 'Moved to another parent group')}>{groups.data.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
      <Field label="Parent visibility"><select className={inputCls} style={inputStyle} value={t.parent_visibility} disabled={!canManage} onChange={e => void save({ parent_visibility: e.target.value as ParentVisibility }, 'Parent visibility updated')}>{(Object.keys(VISIBILITY_LABEL) as ParentVisibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}</select></Field>
      <label className="flex items-center gap-2"><Switch on={t.shared_masters} disabled={!canManage} onChange={v => void save({ shared_masters: v }, v ? 'Shared masters enabled' : 'Shared masters disabled')} label="Shared masters" /> Shared masters with the group</label>
      <label className="flex items-center gap-2"><Switch on={t.inherit_parent_policies} disabled={!canManage} onChange={v => void save({ inherit_parent_policies: v }, 'Policy inheritance updated')} label="Inherit policies" /> Inherit parent’s masters, roles and approval policy</label>
    </div>{canManage && <div className="mt-2.5"><Btn d onClick={() => void save({ detach: true }, `${ov.name} is now standalone`)}>Detach from group</Btn></div>}</Panel>
  </div>
  return <div className="space-y-2">
    <Note>Standalone tenant – not part of any group.</Note>
    {canManage && <Panel title="Attach to a parent group">{!groups.data.groups.length ? <Empty>No parent groups yet. Create one from Tenants &amp; hierarchy.</Empty> : <div className="grid items-end gap-2.5 sm:grid-cols-[1fr_1fr_auto]">
      <Field label="Parent group"><select className={inputCls} style={inputStyle} value={pick} onChange={e => { setPick(e.target.value); const g = groups.data?.groups.find(x => String(x.id) === e.target.value); if (g) setVisibility(g.default_visibility) }}><option value="">— Select —</option>{groups.data.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
      <Field label="Parent visibility"><select className={inputCls} style={inputStyle} value={visibility} onChange={e => setVisibility(e.target.value as ParentVisibility)}>{(Object.keys(VISIBILITY_LABEL) as ParentVisibility[]).map(v => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}</select></Field>
      <Btn p disabled={!pick} onClick={() => void save({ parent_group_id: Number(pick), parent_visibility: visibility }, 'Attached to parent group')}>Attach</Btn>
    </div>}</Panel>}
  </div>
}

function LifecycleTab({ id, ov, reload, canManage, ask }: Ctx & { ask: (c: Confirm) => void }) {
  const { success, info } = useToast()
  const navigate = useNavigate()
  const items: [string, string, ReactNode][] = []
  if (ov.status === 'suspended') items.push(['Reactivate tenant', 'Restore sign-ins for all users.', <Btn key="r" onClick={() => ask({ title: 'Reactivate tenant', label: 'Yes, continue', body: <p>Reactivate {ov.name}?</p>, run: async () => { await platformApi.reactivateTenant(id); success('Tenant active'); await reload() } })}>Reactivate</Btn>])
  else items.push(['Suspend tenant', 'Block sign-ins; data and billing are retained.', <Btn key="s" onClick={() => ask({ title: 'Suspend tenant', label: 'Yes, continue', danger: true, body: <p>Suspend {ov.name}? Users will be blocked immediately.</p>, run: async () => { const { data } = await platformApi.suspendTenant(id); if (isApprovalQueued(data)) info('Sent for approval', data.message); else success('Tenant suspended'); await reload() } })}>Suspend</Btn>])
  if (ov.status === 'trial') items.push(['Extend trial', `Trial ends ${fd(ov.trial_ends_at)}. One extension per tenant, up to the days allowed in Add-ons & usage pricing → Free trial.`, <ExtendTrial key="x" id={id} onDone={reload} />])
  if (ov.status === 'trial') items.push(['Activate tenant', 'End the trial and mark the tenant as an active customer.', <Btn key="a" onClick={() => ask({ title: 'Activate tenant', label: 'Activate', body: <p>Activate {ov.name}? Its plan price will count towards MRR.</p>, run: async () => { await platformApi.reactivateTenant(id); success('Tenant active'); await reload() } })}>Activate</Btn>])
  items.push(['Force sign-out', 'Invalidate every active session for this tenant.', <Btn key="f" onClick={() => ask({ title: 'Force sign-out all users', label: 'Sign out everyone', danger: true, body: <p>All sessions for {ov.name} are invalidated.</p>, run: async () => { await platformApi.forceLogoutTenant(id, 'Forced logout by platform admin'); success('All sessions invalidated') } })}>Sign out</Btn>])
  items.push(['Move to a parent group', 'Attach, move or detach this company in the hierarchy.', <Btn key="h" onClick={() => navigate(`/platform/tenants/${id}?tab=Hierarchy`)}>Hierarchy</Btn>])
  if (ov.deletion_scheduled_at) items.push(['Deletion scheduled', `Suspended and scheduled for deletion on ${fd(ov.deletion_scheduled_at)}. Data is kept until a DBA removes the database.`, <Btn key="c" onClick={() => ask({ title: 'Cancel deletion', label: 'Cancel deletion', body: <p>Cancel the scheduled deletion of {ov.name}? The tenant stays suspended until you reactivate it.</p>, run: async () => { await platformApi.cancelTenantDeletion(id); success('Deletion cancelled'); await reload() } })}>Cancel deletion</Btn>])
  else items.push(['Delete tenant permanently', 'Suspends now and schedules deletion after a 30 day grace period. Requires typing the tenant name.', <Btn key="d" d onClick={() => ask({ title: `Delete ${ov.name}`, label: 'Schedule deletion', danger: true, typed: ov.name, body: <Note>All data, files and backups are removed after a 30 day grace period.</Note>, run: async () => { await platformApi.scheduleTenantDeletion(id, ov.name); success('Tenant suspended and scheduled for deletion in 30 days'); await reload() } })}>Delete…</Btn>])
  return <div className="rounded-md border" style={{ borderColor: C.ln, background: C.sf }}>{items.map(([t, d, b]) => <div key={t} className="flex items-center gap-2 border-b px-2.5 py-2 last:border-0" style={{ borderColor: C.ln2 }}><span className="flex-1"><b>{t}</b><br /><small className="text-xs" style={{ color: C.mu }}>{d}</small></span>{canManage && b}</div>)}</div>
}

export function AuditTable({ rows }: { rows: PlatformAuditRow[] }) {
  if (!rows.length) return <Empty>No events recorded</Empty>
  return <Table head={['When', 'Actor', 'Action', 'Details', 'IP']} minWidth={720}>{rows.map(r => <tr key={r.id}><td className="whitespace-nowrap">{fdt(r.created_at)}</td><td>{r.actor || '—'}</td><td><Pill t="inf">{r.action.replace(/_/g, ' ')}</Pill></td><td>{r.description || ''}</td><td>{r.ip || '—'}</td></tr>)}</Table>
}

function TenantAddonsPanel({ id }: { id: number }) {
  const { success, error: showError } = useToast()
  const { can } = usePlatformAccess()
  const canBill = can('billing', 'manage')
  const { data, error, setData } = useLoad<TenantAddon[]>(() => platformApi.tenantAddons(id), [id])
  const [busy, setBusy] = useState(0)
  const toggle = async (a: TenantAddon, on: boolean) => {
    setBusy(a.addon_id)
    try { setData((await platformApi.setTenantAddon(id, a.addon_id, on)).data); success(on ? `${a.name} added – billed from the next invoice` : `${a.name} removed`) }
    catch (err) { showError(errMsg(err, 'Add-on not changed')) } finally { setBusy(0) }
  }
  return <Panel title="Add-ons" flush>{error ? <Note>{error}</Note> : !data ? <Loading /> : !data.length ? <Empty>No add-ons are offered</Empty> :
    <div className="bw-list">{data.map(a => <div key={a.addon_id}><Switch on={a.active} label={a.name} disabled={!canBill || busy === a.addon_id} onChange={v => void toggle(a, v)} />
      <span className="flex-1">{a.name}{a.status !== 'Active' && <> <Pill t={a.status === 'Paused' ? 'mu' : 'inf'}>{a.status}</Pill></>}</span><b>{inr(a.price)}</b></div>)}</div>}</Panel>
}

function ExtendTrial({ id, onDone }: { id: number; onDone: () => Promise<void> }) {
  const { success, error: showError } = useToast()
  const [days, setDays] = useState('7')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { const { data } = await platformApi.extendTrial(id, Number(days)); success(`Trial extended to ${fd(data.trial_ends_at)}`); await onDone() } catch (err) { showError(errMsg(err, 'Trial not extended')) } finally { setBusy(false) }
  }
  return <span className="flex items-center gap-1.5"><input className={`${inputCls} sm`} style={{ ...inputStyle, width: 64 }} type="number" min={1} value={days} onChange={e => setDays(e.target.value)} /> days
    <Btn disabled={busy || !(Number(days) >= 1)} onClick={() => void go()}>{busy ? 'Extending…' : 'Extend'}</Btn></span>
}

function ContractTab({ id, ov, ask }: Ctx & { ask: (c: Confirm) => void }) {
  const { success, error: showError } = useToast()
  const { can } = usePlatformAccess()
  const canBill = can('billing', 'manage')
  const { data, error, load } = useLoad<TenantDiscounts>(() => platformApi.tenantDiscounts(id), [id])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  if (error) return <Note>{error}</Note>
  if (!data) return <Loading />
  const active = data.negotiated.find(d => d.status_key === 'active')
  const pending = data.negotiated.find(d => d.status_key === 'pending')
  const pick = code || data.eligible_coupons[0] || ''
  const apply = async () => {
    if (!pick) return
    setBusy(true)
    try { await platformApi.redeemCoupon(pick, id); success(`${pick} applied to ${ov.name}`); setCode(''); await load() } catch (err) { showError(errMsg(err, 'Unable to apply coupon')) } finally { setBusy(false) }
  }
  const end = (d: NegotiatedDiscount) => ask({ title: 'End negotiated discount', label: 'End discount', danger: true, body: <p>End the {d.pct}% discount for {ov.name}? Invoices already issued are not recalculated.</p>, run: async () => { await platformApi.decideNegotiatedDiscount(d.id, 'end'); success('Discount ended'); await load() } })
  return <div className="grid gap-2 xl:grid-cols-2">
    <div className="space-y-2">
      <Panel title="Contract"><Kv rows={[
        ['Plan', data.plan || '—'], ['Billing', data.cycle], ['Seats', num(data.seats)], ['Paying', data.paying ? 'Yes' : 'No – not invoiced'],
        ['List price (MRR)', inr(data.list_mrr)], ['Effective MRR', inr(data.effective_mrr)],
      ]} /></Panel>
      <Panel title="Discounts applied" flush><div className="bw-list">
        {active ? <div><span className="flex-1"><b>Negotiated – {active.pct}%</b><br /><small style={{ color: C.mu }}>{active.reason}{active.valid_until ? ` · until ${fd(active.valid_until)}` : ''}</small></span>{canBill && <Btn s d onClick={() => end(active)}>End</Btn>}</div>
          : pending ? <div><span className="flex-1"><b>Negotiated – {pending.pct}%</b><br /><small style={{ color: C.mu }}>Awaiting approval · requested by {pending.requested_by || '—'}</small></span><Link to="/platform/discounts?tab=Approvals" style={{ color: C.ac }}>Review</Link></div>
          : <div><span className="flex-1" style={{ color: C.mu }}>No negotiated discount</span>{canBill && <Link to="/platform/discounts?tab=Tenant%20discounts" style={{ color: C.ac }}>Add</Link>}</div>}
        <div><span className="flex-1">{data.volume_tier ? <><b>Volume – {data.volume_tier.pct}%</b><br /><small style={{ color: C.mu }}>Band {data.volume_tier.from}–{data.volume_tier.to ?? '∞'} seats</small></> : <span style={{ color: C.mu }}>Volume discounts are off</span>}</span></div>
        {data.redemptions.map(r => <div key={r.code}><span className="flex-1"><b>{r.code} – {r.kind === 'percent' ? `${r.value}%` : inr(r.value)}</b><br /><small style={{ color: C.mu }}>{r.duration} · applied {fd(r.redeemed_at)}{r.redeemed_by ? ` by ${r.redeemed_by}` : ''}</small></span><Pill t={r.status === 'active' ? 'ok' : 'mu'}>{cap(r.status)}</Pill></div>)}
      </div></Panel>
    </div>
    <div className="space-y-2">
      <TenantAddonsPanel id={id} />
      <Panel title="Apply a coupon">{!data.eligible_coupons.length ? <Empty>No active coupon applies to this tenant’s plan</Empty> : <>
        <div className="flex gap-1.5"><select className={inputCls} style={inputStyle} value={pick} disabled={!canBill} onChange={e => setCode(e.target.value)}>{data.eligible_coupons.map(c => <option key={c}>{c}</option>)}</select>{canBill && <Btn p onClick={() => void apply()} disabled={busy}>{busy ? 'Applying…' : 'Apply'}</Btn>}</div>
        <div className="mt-2 text-xs" style={{ color: C.mu }}>Stacking follows the rules in Discounts &amp; coupons. Issued invoices are never recalculated.</div>
      </>}</Panel>
    </div>
  </div>
}

function AuditTab({ id }: Ctx) {
  const { data, error } = useLoad<PlatformAuditRow[]>(() => platformApi.tenantPlatformAudit(id), [id])
  return <Panel title="Recent events" flush act={<Link to={`/platform/tenants/${id}/audit`} className="text-xs font-normal" style={{ color: C.ac }}>Tenant activity log →</Link>}>{error ? <Note>{error}</Note> : !data ? <Loading /> : <AuditTable rows={data} />}</Panel>
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PlatformTenantDetailPage() {
  const id = Number(useParams().id)
  const [params, setParams] = useSearchParams()
  const tab = (TENANT_TABS as readonly string[]).includes(params.get('tab') || '') ? params.get('tab')! : 'Overview'
  const { can } = usePlatformAccess()
  const canManage = can('tenants', 'manage')
  const [ov, setOv] = useState<TenantOverview | null>(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const reload = useCallback(async () => {
    try { setOv((await platformApi.tenantOverview(id)).data); setError('') } catch (err) { setError(errMsg(err, 'Unable to load tenant')) }
  }, [id])
  useEffect(() => { void reload() }, [reload])

  if (error) return <div className="page-body"><Note>{error}</Note></div>
  if (!ov) return <div className="page-body"><Loading /></div>
  const ctx: Ctx = { id, ov, reload, canManage }
  const ask = (c: Confirm) => setConfirm(c)
  const body: Record<string, () => ReactNode> = {
    Overview: () => <OverviewTab {...ctx} ask={ask} />, 'Settings overrides': () => <SettingsTab {...ctx} />, 'Contract & discounts': () => <ContractTab {...ctx} ask={ask} />, Database: () => <DatabaseTab {...ctx} ask={ask} />,
    Monitoring: () => <MonitoringTab {...ctx} />, 'Backups & recovery': () => <BackupsTab {...ctx} ask={ask} />, 'Data & migration': () => <TenantDataMigrationTab {...ctx} />,
    Modules: () => <ModulesTab {...ctx} />, 'Users & access': () => <UsersTab {...ctx} ask={ask} />, Configuration: () => <ConfigurationTab {...ctx} />,
    'Limits & metering': () => <LimitsTab {...ctx} />, Billing: () => <BillingTab {...ctx} ask={ask} />, Security: () => <SecurityTab {...ctx} />,
    Hierarchy: () => <HierarchyTab {...ctx} />, Lifecycle: () => <LifecycleTab {...ctx} ask={ask} />, Audit: () => <AuditTab {...ctx} />,
  }
  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {confirm && <ConfirmModal c={confirm} onClose={() => setConfirm(null)} />}
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div>
        <div className="mb-0.5 text-xs" style={{ color: C.mu }}><Link to="/platform/tenants" style={{ color: C.ac }}>Tenants</Link>{ov.parent_group_id && <> / <Link to={`/platform/tenant-groups/${ov.parent_group_id}`} style={{ color: C.ac }}>{ov.parent_name}</Link></>} / {ov.name}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-sm font-bold text-white" style={{ background: ov.color || C.ac }}>{ov.name.charAt(0).toUpperCase()}</span>
          <h1 className="text-xl font-semibold">{ov.name}</h1>
          <Pill t={statusTone(ov.status)}>{cap(ov.status)}</Pill>
          <Pill t="ac">{ov.plan?.name || 'No plan'}</Pill>
          {ov.server && <Pill t="mu">{ov.server}</Pill>}
          {ov.deletion_scheduled_at && <Pill t="ba">Deletion {fd(ov.deletion_scheduled_at)}</Pill>}
          {ov.maintenance_mode && <Pill t="wa">Maintenance</Pill>}
        </div>
      </div>
      <span className="flex-1" />
      <Link to={`/platform/tenants/${id}?tab=Configuration`} className="inline-flex h-7 items-center gap-1.5 rounded-md border px-[11px] font-medium text-white" style={{ background: C.ac, borderColor: C.ac, color: '#fff' }}><Settings size={14} /> Configure</Link>
    </div>
    <div className="rounded-md border" style={{ background: C.sf, borderColor: C.ln }}>
      <Tabs tabs={TENANT_TABS} active={tab} onChange={t => setParams({ tab: t }, { replace: true })} />
      <div className="p-2.5" style={{ background: 'var(--bw-bg)' }}>{body[tab]()}</div>
    </div>
  </div>
}
