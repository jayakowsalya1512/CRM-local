import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Play, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  platformApi,
  type DatabasesOverview,
  type DbFailoverDrill,
  type DbServerCard,
  type DbServerTest,
  type DbSqlResult,
  type DbTenantPlacement,
} from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { copyText, Btn, BwModal, C, Empty, Field, Kv, Note, Panel, Pill, Strip, errMsg, fd, inputCls, inputStyle, mb, num } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'

// Layout, KPI order, sections and columns follow the Bidwise prototype Databases page (P.db).
// Self-hosted MariaDB: a cluster is a database server / instance, a schema is the tenant's own database,
// and the schema version is the database migration version. Everything shown is read live by the backend.
const REFRESH_MS = 30_000
const rid = (t: DbTenantPlacement) => String(t.id)
const tone = (v: number) => v > 75 ? C.ba : v > 55 ? C.wa : C.ok
const size = (v: number | null | undefined) => v == null ? '—' : v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} TB` : mb(v)
const bar = (v: number) => <span className="inline-flex items-center"><span className="mr-[5px] inline-block h-1.5 w-[60px] overflow-hidden rounded-md align-middle" style={{ background: C.ln2 }}><i className="block h-full" style={{ width: `${Math.min(100, v)}%`, background: C.ac }} /></span>{Math.round(v)}%</span>
const migrationTone = { Done: 'ok', 'In Progress': 'wa', Running: 'inf', Pending: 'mu' } as const

function Gauge({ label, value, title }: { label: string; value: number | null; title?: string }) {
  return <div className="mt-[5px] flex items-center gap-2" title={title}>
    <small className="w-[76px] shrink-0 text-xs">{label}</small>
    {value == null ? <small className="flex-1 text-xs" style={{ color: C.mu }}>Unavailable</small> : <>
      <div className="h-1.5 flex-1 overflow-hidden rounded-md" style={{ background: C.ln2 }}><i className="block h-full" style={{ width: `${Math.min(100, value)}%`, background: tone(value) }} /></div>
      <small className="text-xs tabular-nums">{Math.round(value)}%</small></>}
  </div>
}

function ServerCard({ s, canManage, onFailover, onResize }: { s: DbServerCard; canManage: boolean; onFailover: () => void; onResize: () => void }) {
  const roleTone = s.role === 'Primary' ? 'ac' : s.role === 'Unknown' ? 'wa' : 'mu'
  return <Panel title={<>{s.name} <Pill t={roleTone} title={s.role_error || (s.replica_of ? `Replicating from ${s.replica_of}` : s.replica_names.length ? `Replicas: ${s.replica_names.join(', ')}` : undefined)}>{s.role}</Pill>{!s.reachable && <Pill t="ba">Unreachable</Pill>}</>}>
    <small className="text-xs" style={{ color: C.mu }}>{s.region} · {s.version || 'MariaDB'}</small>
    {s.error && <div className="mt-1 text-xs" style={{ color: C.ba }}>{s.error}</div>}
    <Gauge label="CPU" value={s.cpu_percent} title={s.metrics_error || undefined} />
    <Gauge label="Memory" value={s.memory_percent} title={s.metrics_error || undefined} />
    <Gauge label="Connections" value={s.connections_percent} title={s.connections != null ? `${num(s.connections)} / ${num(s.max_connections)} connections` : undefined} />
    <Gauge label="Storage" value={s.storage_percent} title={s.storage_detail || s.metrics_error || undefined} />
    <div className="mt-2.5 flex items-center gap-1.5">
      <small className="flex-1 text-xs" style={{ color: C.mu }}>{s.tenant_count} tenant{s.tenant_count === 1 ? '' : 's'}{s.lag_seconds != null ? ` · lag ${s.lag_seconds} s` : s.role === 'Replica' ? ' · lag unknown' : ''}</small>
      {s.failover.visible && <Btn s disabled={!canManage} onClick={onFailover} title={s.failover.enabled ? undefined : s.failover.reason}>Failover</Btn>}
      <Btn s disabled={!canManage || !s.reachable} onClick={onResize}>Resize</Btn>
    </div>
  </Panel>
}

// ─── Modals ─────────────────────────────────────────────────────────────────

function MoveModal({ tenant, data, onClose }: { tenant: DbTenantPlacement; data: DatabasesOverview; onClose: () => void }) {
  const targets = data.servers.filter(s => s.role !== 'Replica' && s.name !== tenant.server)
  return <BwModal title={`Move ${tenant.name} to another server`} width={480} onClose={onClose}
    foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={!data.capabilities.move || !targets.length} title={data.capabilities.move ? undefined : data.capabilities.move_reason}>Start migration</Btn></>}>
    <div className="space-y-2.5">
      <p>Database <b>{tenant.db_name}</b> is on <b>{tenant.server || 'no reachable server'}</b> ({size(tenant.size_mb)}).</p>
      <Field label="Target server"><select className={inputCls} style={inputStyle} disabled={!targets.length}>
        {targets.length ? targets.map(s => <option key={s.name}>{s.name} · {s.region} · CPU {s.cpu_percent == null ? '—' : `${Math.round(s.cpu_percent)}%`}</option>) : <option>No other database server</option>}
      </select></Field>
      <Note>{data.capabilities.move_reason}</Note>
    </div>
  </BwModal>
}

function FailoverModal({ s, onClose, onDone }: { s: DbServerCard; onClose: () => void; onDone: () => Promise<void> }) {
  const { success, error: showError } = useToast()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const target = s.replica_of ? s.name : s.replica_names[0]
  const go = async () => {
    setBusy(true)
    try { const { data } = await platformApi.dbFailover(s.name, confirm); success('Failover complete', `${data.promoted} is now the primary`); await onDone(); onClose() }
    catch (err) { showError(errMsg(err, 'Failover failed')) } finally { setBusy(false) }
  }
  return <BwModal title={`Failover · ${s.name}`} width={500} onClose={onClose}
    foot={<><Btn onClick={onClose}>Cancel</Btn>{s.failover.enabled && <Btn d disabled={busy || confirm.trim() !== s.name} onClick={() => void go()}>{busy ? 'Promoting…' : `Promote ${target}`}</Btn>}</>}>
    {s.failover.enabled ? <div className="space-y-2.5">
      <p>{s.replica_of ? <>Promote replica <b>{s.name}</b> and set <b>{s.replica_of}</b> read-only.</> : <>Set <b>{s.name}</b> read-only and promote its replica <b>{target}</b>.</>} Writes pause until the replica has caught up (max 30 s); if it doesn’t, the failover is aborted and the primary is reopened.</p>
      <Field label={`Type ${s.name} to confirm`}><input className={inputCls} style={inputStyle} value={confirm} onChange={e => setConfirm(e.target.value)} /></Field>
    </div> : <Note>{s.failover.reason}</Note>}
  </BwModal>
}

function ResizeModal({ s, onClose, onDone }: { s: DbServerCard; onClose: () => void; onDone: () => Promise<void> }) {
  const { success, error: showError } = useToast()
  const [conn, setConn] = useState(String(s.max_connections ?? ''))
  const [pool, setPool] = useState(String(s.buffer_pool_mb ?? ''))
  const [busy, setBusy] = useState(false)
  const go = async () => {
    const body: { max_connections?: number; buffer_pool_mb?: number } = {}
    if (conn && Number(conn) !== s.max_connections) body.max_connections = Number(conn)
    if (pool && Number(pool) !== s.buffer_pool_mb) body.buffer_pool_mb = Number(pool)
    if (!Object.keys(body).length) return showError('Change the connection limit or buffer pool size')
    setBusy(true)
    try { const { data } = await platformApi.dbResize(s.name, body); success(`${s.name} resized`, `max_connections ${data.after.max_connections} · buffer pool ${data.after.buffer_pool_mb} MB`); await onDone(); onClose() }
    catch (err) { showError(errMsg(err, 'Resize failed')) } finally { setBusy(false) }
  }
  return <BwModal title={`Resize ${s.name}`} width={480} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy} onClick={() => void go()}>{busy ? 'Applying…' : 'Apply'}</Btn></>}>
    <div className="space-y-2.5">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label="Max connections"><input type="number" min={10} className={inputCls} style={inputStyle} value={conn} onChange={e => setConn(e.target.value)} /></Field>
        <Field label="InnoDB buffer pool (MB)"><input type="number" min={128} className={inputCls} style={inputStyle} value={pool} onChange={e => setPool(e.target.value)} /></Field>
      </div>
      <Note info>Applied online with <code>SET GLOBAL</code> (needs the SUPER privilege). Add the same values to the server’s <code>my.cnf</code> to keep them after a restart. CPU, RAM and disk are resized on the host itself.</Note>
    </div>
  </BwModal>
}

function ProvisionModal({ onClose }: { onClose: () => void }) {
  const { error: showError, success } = useToast()
  const [form, setForm] = useState({ name: '', region: '', host: '', port: '3306', user: '', password: '' })
  const [result, setResult] = useState<DbServerTest | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => { setForm(f => ({ ...f, [k]: e.target.value })); setResult(null) }
  const test = async () => {
    if (!form.name.trim() || !form.host.trim()) return showError('Enter a server name and host')
    setBusy(true)
    try { setResult((await platformApi.dbTestServer({ ...form, port: Number(form.port) || 3306 })).data) }
    catch (err) { showError(errMsg(err, 'Connection failed')) } finally { setBusy(false) }
  }
  const entry = result ? JSON.stringify(result.inventory_entry) : ''
  return <BwModal title="Provision cluster" width={560} onClose={onClose} foot={<><Btn onClick={onClose}>Close</Btn><Btn p disabled={busy} onClick={() => void test()}>{busy ? 'Connecting…' : 'Test connection'}</Btn></>}>
    <div className="space-y-2.5">
      <p>Register a MariaDB server / database instance you have set up. The platform connects to it, then gives you its inventory entry.</p>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <Field label="Server name"><input className={inputCls} style={inputStyle} value={form.name} onChange={set('name')} placeholder="db-2" /></Field>
        <Field label="Region / site"><input className={inputCls} style={inputStyle} value={form.region} onChange={set('region')} placeholder="On-premise" /></Field>
        <Field label="Host"><input className={inputCls} style={inputStyle} value={form.host} onChange={set('host')} placeholder="10.0.0.12" /></Field>
        <Field label="Port"><input type="number" className={inputCls} style={inputStyle} value={form.port} onChange={set('port')} /></Field>
        <Field label="User (blank = tenant DB user)"><input className={inputCls} style={inputStyle} value={form.user} onChange={set('user')} autoComplete="off" /></Field>
        <Field label="Password"><input type="password" className={inputCls} style={inputStyle} value={form.password} onChange={set('password')} autoComplete="new-password" /></Field>
      </div>
      {result && <>
        <Kv rows={[['Engine', result.version], ['Role', result.role], ['Tenant databases', result.tenant_databases], ['Status', result.already_registered ? <Pill t="ok">Already in inventory</Pill> : <Pill t="wa">Not registered yet</Pill>]]} />
        {!result.already_registered && <Note info>
          <div className="mb-1">Add this entry to <code>PLATFORM_SERVERS</code> in the backend <code>.env</code>{result.inventory_entry.db_password ? ' (replace <password>)' : ''} and restart the API:</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md p-1.5 text-xs" style={{ background: C.hd }}>{entry}</pre>
          <Btn s onClick={() => { void copyText(entry).then(ok => ok ? success('Copied') : showError('Copy failed – select the text and copy it')) }}>Copy entry</Btn>
        </Note>}
      </>}
    </div>
  </BwModal>
}

function DrillModal({ drill, onClose }: { drill: DbFailoverDrill; onClose: () => void }) {
  return <BwModal title={<>Failover drill <Pill t={drill.passed ? 'ok' : 'ba'}>{drill.passed ? 'Passed' : 'Failed'}</Pill></>} width={600} onClose={onClose} foot={<Btn onClick={onClose}>Close</Btn>}>
    <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 480 }}>
      <thead><tr><th>Replica</th><th>Primary</th><th className="text-right">Lag</th><th>Result</th></tr></thead>
      <tbody>{drill.checks.map(c => <tr key={c.server}><td><b>{c.server}</b></td><td>{c.primary || '—'}</td><td className="text-right tabular-nums">{c.lag_seconds == null ? '—' : `${c.lag_seconds} s`}</td>
        <td>{c.passed ? <Pill t="ok">Ready</Pill> : <span style={{ color: C.ba }}>{c.problems.join(' · ')}</span>}</td></tr>)}</tbody>
    </table></div>
    <small className="mt-2 block text-xs" style={{ color: C.mu }}>A drill checks replication without switching servers. The result is written to the audit log.</small>
  </BwModal>
}

// ─── SQL console ────────────────────────────────────────────────────────────

function SqlConsole({ data, canRun }: { data: DatabasesOverview; canRun: boolean }) {
  const tenants = data.tenants
  const [tid, setTid] = useState<number | null>(tenants[0]?.id ?? null)
  const [sql, setSql] = useState(data.sql_examples[0] ?? '')
  const [res, setRes] = useState<DbSqlResult | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (tid == null && tenants.length) setTid(tenants[0].id) }, [tid, tenants])
  const replica = data.servers.some(s => s.role === 'Replica' && s.reachable)
  const run = async (q = sql) => {
    if (tid == null) return
    setBusy(true); setErr('')
    try { setRes((await platformApi.dbRunSql(tid, q)).data) } catch (e) { setRes(null); setErr(errMsg(e, 'Query failed')) } finally { setBusy(false) }
  }
  const { sql_row_limit: limit, sql_timeout_seconds: timeout } = data.capabilities
  return <Panel title="SQL console · read-only replica" act={
    <select className={`${inputCls} !h-6 !w-[220px] text-xs`} style={inputStyle} value={tid ?? ''} onChange={e => { setTid(Number(e.target.value)); setRes(null); setErr('') }} aria-label="Tenant">
      {tenants.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>}>
    <textarea rows={3} spellCheck={false} value={sql} onChange={e => setSql(e.target.value)} aria-label="SQL query" maxLength={5000}
      className="w-full resize-y rounded-md border p-2 text-[12.5px] leading-[1.5]" style={{ background: '#0E1621', color: '#D3E4F6', borderColor: '#2A3A4D', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' }} />
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <Btn p s disabled={!canRun || busy || tid == null || !sql.trim()} title={canRun ? undefined : 'Your platform role can’t run queries'} onClick={() => void run()}><Play size={12} /> {busy ? 'Running…' : 'Run query'}</Btn>
      {data.sql_examples.map(q => <button key={q} type="button" disabled={!canRun || busy || tid == null} onClick={() => { setSql(q); void run(q) }}
        className="inline-flex h-[22px] items-center whitespace-nowrap rounded-[11px] border px-2 text-xs disabled:opacity-50" style={{ borderColor: C.ln, background: C.sf, color: C.tx }}>{q.slice(0, 34)}…</button>)}
    </div>
    <div className="mt-2">
      {err ? <Note className="!border-[var(--bw-ba)]">{err}</Note> : res ? <>
        <div className="max-h-[260px] overflow-auto rounded-md border" style={{ borderColor: C.ln }}>
          {res.columns.length ? <table className="w-full text-left text-xs">
            <thead className="sticky top-0"><tr>{res.columns.map((c, i) => <th key={i} className="whitespace-nowrap">{c}</th>)}</tr></thead>
            <tbody>{res.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="whitespace-nowrap">{v == null ? <span style={{ color: C.mu }}>NULL</span> : String(v)}</td>)}</tr>)}</tbody>
          </table> : <Empty>Statement returned no result set</Empty>}
        </div>
        <small className="text-xs" style={{ color: C.mu }}>{res.row_count}{res.truncated ? `+ (first ${res.row_limit})` : ''} rows · {res.elapsed_ms} ms · {res.replica ? 'read replica' : 'primary, read-only transaction'} {res.server} · {res.database}</small>
      </> : <small className="text-xs" style={{ color: C.mu }}>Queries run {replica ? 'against a read replica' : 'in a read-only transaction (no read replica is configured)'} on the tenant’s own database with a {timeout} s timeout and a {limit}-row cap. All statements are written to the audit trail.</small>}
    </div>
  </Panel>
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function PlatformDatabasesPage() {
  const { can } = usePlatformAccess()
  const navigate = useNavigate()
  const canManage = can('databases', 'manage')
  const { success, error: showError } = useToast()
  const [data, setData] = useState<DatabasesOverview | null>(null)
  const [error, setError] = useState('')
  const [move, setMove] = useState<DbTenantPlacement | null>(null)
  const [failover, setFailover] = useState<DbServerCard | null>(null)
  const [resize, setResize] = useState<DbServerCard | null>(null)
  const [provision, setProvision] = useState(false)
  const [drill, setDrill] = useState<DbFailoverDrill | null>(null)
  const [continuing, setContinuing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try { const { data: next } = await platformApi.databasesOverview(); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Unable to load database servers')) }
  }, [])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!document.hidden) void load() }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [load])

  const runFailoverDrill = async () => {
    setBusy('drill')
    try { setDrill((await platformApi.dbFailoverDrill()).data); await load() } catch (err) { showError(errMsg(err, 'Failover drill failed')) } finally { setBusy(null) }
  }
  const runRestoreDrill = async () => {
    setBusy('restore')
    try { const { data: r } = await platformApi.dbRestoreDrill(); (r.passed ? success : showError)(r.description); await load() }
    catch (err) { showError(errMsg(err, 'Restore drill failed')) } finally { setBusy(null) }
  }
  const continueMigration = async (version: string) => {
    setBusy(version)
    try { await platformApi.continueDbMigration(version); success(`Migration ${version} rollout resumed`, 'Runs in the background on every tenant database'); setContinuing(null); await load() }
    catch (err) { showError(errMsg(err, 'Unable to resume the rollout')) } finally { setBusy(null) }
  }

  const cols: GridCol<DbTenantPlacement>[] = useMemo(() => [
    { k: 'name', t: 'Tenant', w: 230, fn: t => <b>{t.name}</b> },
    { k: 'db_name', t: 'Database Name', w: 160 },
    { k: 'server', t: 'Server', w: 130, txt: t => t.server || '—', fn: t => t.server ? <Pill t="ac">{t.server}</Pill> : <Pill t="ba">Not found</Pill> },
    { k: 'size', t: 'Size', r: true, sum: true, sv: t => t.size_mb ?? 0, sumv: t => t.size_mb ?? 0, sumFmt: size, txt: t => size(t.size_mb) },
    { k: 'qps', t: 'Queries / s', r: true, sv: t => t.qps ?? -1, txt: t => t.qps == null ? '—' : String(t.qps),
      fn: t => t.qps == null ? <span title="Database not found on a reachable server" style={{ color: C.mu }}>—</span>
        : <span title={t.qps_source === 'performance_schema' ? 'Measured by the server (performance_schema)' : 'Statements sent by the platform API in the last 60 s (performance_schema is off on this server)'}>{t.qps}</span> },
    { k: 'connections', t: 'Connections', r: true, sv: t => t.connections ?? -1, txt: t => t.connections == null ? '—' : String(t.connections) },
    { k: 'version', t: 'Database Migration Version', w: 190, txt: t => t.migration_version || '—',
      fn: t => t.migration_version == null ? <span style={{ color: C.mu }}>—</span> : data && t.migration_version !== data.kpis.schema_version ? <span style={{ color: C.wa }} title={`Behind ${data.kpis.schema_version}`}>{t.migration_version}</span> : t.migration_version },
    { k: 'x', t: '', w: 80, txt: () => '', fn: t => <span onClick={e => e.stopPropagation()}><Btn s disabled={!canManage} onClick={() => setMove(t)}>Move…</Btn></span> },
  ], [canManage, data])

  const k = data?.kpis
  const bp = data?.backup_policy
  const policy = (f: { value: string; note: string | null } | undefined) => f ? <span title={f.note || undefined}>{f.value}{f.note && <small className="block text-[11px]" style={{ color: C.mu }}>{f.note}</small>}</span> : '—'

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {move && data && <MoveModal tenant={move} data={data} onClose={() => setMove(null)} />}
    {failover && <FailoverModal s={failover} onClose={() => setFailover(null)} onDone={load} />}
    {resize && <ResizeModal s={resize} onClose={() => setResize(null)} onDone={load} />}
    {provision && <ProvisionModal onClose={() => setProvision(false)} />}
    {drill && <DrillModal drill={drill} onClose={() => setDrill(null)} />}
    {continuing && <BwModal title={`Continue migration ${continuing}`} width={460} onClose={() => setContinuing(null)}
      foot={<><Btn onClick={() => setContinuing(null)}>Cancel</Btn><Btn p disabled={busy === continuing} onClick={() => void continueMigration(continuing)}>{busy === continuing ? 'Starting…' : 'Run'}</Btn></>}>
      <p>Re-run this idempotent schema migration on every tenant database that has not reached it. ALTER statements may briefly lock the affected tables.</p>
    </BwModal>}

    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <div><div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div><h1 className="text-xl font-semibold">Databases</h1></div>
      <span className="flex-1" />
      <Btn disabled={!canManage || !data?.capabilities.failover_drill || busy === 'drill'} onClick={() => void runFailoverDrill()}
        title={data && !data.capabilities.failover_drill ? 'No database server is replicating, so there is nothing to fail over to' : undefined}>{busy === 'drill' ? 'Running drill…' : 'Failover drill'}</Btn>
      {canManage && <Btn p onClick={() => setProvision(true)}><Plus size={14} /> Provision cluster</Btn>}
    </div>
    {error && <Note className="mb-2">{error}</Note>}

    <Strip items={[
      { l: 'Clusters', v: k ? k.clusters : '—', kpi: 'databases.clusters' },
      { l: 'Total size', v: k ? size(k.total_size_mb) : '—', d: k ? `${size(k.server_size_mb)} on servers` : undefined, kpi: 'databases.total_size' },
      { l: 'Connections', v: k ? `${num(k.connections)} / ${num(k.max_connections)}` : '—', d: k ? `${num(k.tenant_connections)} tenant` : undefined, kpi: 'databases.connections' },
      { l: 'Max replication lag', v: !k ? '—' : k.max_replication_lag != null ? <span style={{ color: k.max_replication_lag > 10 ? C.wa : C.ok }}>{k.max_replication_lag} s</span> : '—', d: k && !k.replication_configured ? 'no replication' : undefined, kpi: 'databases.replication_lag' },
      { l: 'Failovers · 90d', v: k ? k.failovers_90d : '—', kpi: 'databases.failovers' },
      { l: 'Schema version', v: k ? k.schema_version : '—', d: k?.tenants_behind ? `${k.tenants_behind} behind` : undefined, c: C.wa, kpi: 'databases.schema_version' },
    ]} />

    {!data ? <Panel title="Database servers"><Empty>{error ? 'Database servers unavailable' : 'Loading…'}</Empty></Panel> : <>
      <div className="mb-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {data.servers.length ? data.servers.map(s => <ServerCard key={s.name} s={s} canManage={canManage} onFailover={() => setFailover(s)} onResize={() => setResize(s)} />)
          : <Panel title="No database servers"><Empty>Add servers with a db_host in PLATFORM_SERVERS.</Empty></Panel>}
      </div>

      <div className="mb-2"><Panel title="Tenant placement" flush>
        <BwGrid id="db-placement" cols={cols} rows={data.tenants} rid={rid} onRow={t => navigate(`/platform/tenants/${t.id}`)} empty="No tenants" />
      </Panel></div>

      <div className="mb-2 grid gap-2 xl:grid-cols-2">
        <Panel title="Schema migrations" flush>
          <div className="overflow-x-auto"><table className="w-full text-left" style={{ minWidth: 520 }}>
            <thead><tr><th>Version</th><th>Description</th><th>Rolled out</th><th>Status</th><th /></tr></thead>
            <tbody>{data.migrations.map(m => <tr key={m.version}>
              <td className="tabular-nums" style={{ color: C.ac }}>{m.version}</td>
              <td>{m.description}</td>
              <td title={`${m.applied} of ${m.total} tenant databases`}>{bar(m.rolled_out)}</td>
              <td><Pill t={migrationTone[m.status]}>{m.status}</Pill></td>
              <td className="text-right">{m.rolled_out < 100 && m.status !== 'Running' && m.total > 0 && canManage && <Btn s disabled={busy === m.version} onClick={() => setContinuing(m.version)}>Continue</Btn>}</td>
            </tr>)}</tbody>
          </table></div>
        </Panel>
        <Panel title="Backup policy (platform default)">
          {bp && <Kv rows={[
            ['Snapshots', policy(bp.snapshots)],
            ['Point-in-time', policy(bp.point_in_time)],
            ['Cross-region copy', policy(bp.cross_region_copy)],
            ['Restore drills', policy(bp.restore_drills)],
            ['Last drill', <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
              {bp.last_drill ? <span title={bp.last_drill.detail}><span style={{ color: bp.last_drill.passed ? C.ok : C.ba }}>{bp.last_drill.passed ? 'Passed' : 'Failed'}</span> · {fd(bp.last_drill.at)}</span> : 'Never run'}
              {canManage && <Btn s disabled={busy === 'restore'} onClick={() => void runRestoreDrill()}>{busy === 'restore' ? 'Restoring…' : 'Run drill'}</Btn>}
            </span>],
          ]} />}
        </Panel>
      </div>

      <SqlConsole data={data} canRun={canManage} />
    </>}
  </div>
}
