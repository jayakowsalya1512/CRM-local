import { useCallback, useEffect, useRef, useState } from 'react'
import { platformApi, type DataTransferOverview, type ExportVerify, type MigrationConnector } from '@/services/platformApi'
import { useToast } from '@/components/ui/FormComponents'
import BwGrid, { type GridCol } from '@/components/platform/BwGrid'
import { copyText, Btn, BwModal, C, Empty, Field, Ic, Kv, Note, Panel, Pill, Strip, Table, Tabs, downloadBlob, errMsg, fd, fdt, inputCls, inputStyle, num } from '@/components/platform/bw'
import { usePlatformAccess } from '@/components/platform/usePlatformAccess'
import { ExportWizard, MigrationWizard, TARGET_LABELS, bar, exportPill, migTone, sizeText } from './TenantDataMigrationTab'

// Layout, tabs, columns, actions and connectors follow the Bidwise prototype Data export & migration page (P.dx).
// Exports and migrations run through the tenant routes (scope-checked per tenant); connectors validate against each vendor.
type ExportRow = DataTransferOverview['exports'][number]
type MigrationRowT = DataTransferOverview['migrations'][number]
const TABS = ['Tenant exports', 'Migration projects', 'Source connectors'] as const
const COMPONENTS = 7
const formatShort = (f: string) => f.split(' (')[0].split(' +')[0]
const rowId = (r: { id: number }) => String(r.id)  // stable: BwGrid re-validates its selection whenever rid changes
const ACTIVE = ['Running', 'Pausing', 'Fetching']

function LinkModal({ job, onClose }: { job: ExportRow; onClose: () => void }) {
  const { success, error: showError } = useToast()
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null)
  useEffect(() => { platformApi.exportLink(job.tenant.id, job.id).then(({ data }) => setLink(data)).catch(err => { showError(errMsg(err, 'Unable to create the download link')); onClose() }) }, [job, onClose, showError])
  const copy = async () => { if (!link) return; if (await copyText(link.url)) success('Signed link copied'); else showError('Copy failed – select the link and copy it') }
  return <BwModal title={`Download link · ${job.job}`} width={620} onClose={onClose} foot={<><Btn onClick={onClose}>Close</Btn><Btn disabled={!link} onClick={() => void copy()}><Ic n="copy" /> Copy link</Btn><Btn p disabled={!link} onClick={() => link && window.open(link.url, '_blank', 'noopener')}><Ic n="dl" /> Download</Btn></>}>
    {!link ? <Empty>Signing the link…</Empty> : <div className="space-y-2.5">
      <textarea readOnly className="w-full rounded-md border px-2 py-1 font-mono text-[11px]" rows={3} style={inputStyle} value={link.url} onFocus={e => e.currentTarget.select()} />
      <Kv rows={[['Tenant', job.tenant.name], ['Valid until', fdt(link.expires_at)], ['Package SHA-256', <code key="s" className="break-all text-[11px]">{job.sha256}</code>],
        ['Encryption', job.encryption + (job.pgp_fingerprint ? ` · key ${job.pgp_fingerprint.slice(-16)}` : '')]]} />
      <Note info>Anyone holding this link can download the package until it expires; issuing it is recorded in the audit trail. {job.encryption.startsWith('AES') ? 'The platform decrypts the package while it downloads.' : job.encryption.includes('PGP') ? 'The file stays PGP-encrypted – open it with the customer’s private key.' : ''}</Note>
    </div>}
  </BwModal>
}

function ChecksumModal({ job, onClose }: { job: ExportRow; onClose: () => void }) {
  const { success, error: showError } = useToast()
  const [result, setResult] = useState<ExportVerify | null>(null)
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    platformApi.verifyExport(job.tenant.id, job.id).then(({ data }) => setResult(data)).catch(err => showError(errMsg(err, 'Verification failed'))).finally(() => setBusy(false))
  }, [job, showError])
  const copy = async (v: string) => { if (await copyText(v)) success('SHA-256 copied'); else showError('Copy failed – select the checksum and copy it') }
  const mark = (v: boolean | null) => v == null ? <Pill t="mu">Not applicable</Pill> : v ? <Pill t="ok">Matches</Pill> : <Pill t="ba">Does not match</Pill>
  return <BwModal title={`Checksum · ${job.job}`} width={620} onClose={onClose} foot={<><Btn onClick={onClose}>Close</Btn><Btn disabled={!job.sha256} onClick={() => job.sha256 && void copy(job.sha256)}><Ic n="copy" /> Copy SHA-256</Btn></>}>
    {busy ? <Empty>Recomputing checksums from the stored file…</Empty> : !result ? <Empty>Verification unavailable</Empty> : <div className="space-y-2.5">
      {result.verified ? <Note info><b>Checksum verified.</b> The stored package is intact.</Note> : <Note><b>Checksum mismatch.</b> The stored file changed since it was written – do not hand it out; retry the export.</Note>}
      <Kv rows={[['Package (ZIP) SHA-256', <code key="p" className="break-all text-[11px]">{result.package_sha256}</code>], ['Package check', mark(result.package_ok)],
        ['Stored file SHA-256', <code key="f" className="break-all text-[11px]">{result.file_sha256}</code>], ['Stored file check', mark(result.file_ok)]]} />
      <small style={{ color: C.mu }}>Every file inside the package is also listed with its own SHA-256 in manifest.json.</small>
    </div>}
  </BwModal>
}

function ReportModal({ m, onClose, onChanged }: { m: MigrationRowT; onClose: () => void; onChanged: () => void }) {
  const { success, error: showError } = useToast()
  const [busy, setBusy] = useState(false)
  const res = m.result, d = m.dry_run
  const rollback = async () => {
    setBusy(true)
    try { await platformApi.rollbackMigration(m.tenant.id, m.id); success('Migration rolled back'); onChanged(); onClose() } catch (err) { showError(errMsg(err, 'Rollback failed')) } finally { setBusy(false) }
  }
  return <BwModal title={`Validation report · ${m.project}`} width={760} onClose={onClose} foot={<><Btn onClick={onClose}>Close</Btn>
    {d && <Btn onClick={() => void platformApi.migrationErrors(m.tenant.id, m.id).then(({ data }) => downloadBlob(data as Blob, `${m.project}-issues.csv`)).catch(err => showError(errMsg(err, 'Download failed')))}><Ic n="dl" /> Error report</Btn>}
    {(m.rollback_until || m.can_rollback) && <Btn d disabled={busy} onClick={() => void rollback()}>Roll back</Btn>}</>}>
    <Kv rows={[['Target tenant', m.tenant.name], ['Source', m.source], ['Status', <Pill key="s" t={migTone(m.status)}>{m.status}</Pill>], ['Started', fdt(m.created_at)], ['Finished', fdt(m.completed_at)], ['By', m.created_by ?? '—']]} />
    {res && <div className="mt-2.5"><Strip items={[...Object.entries(res.created ?? {}).filter(([, ids]) => ids.length).map(([t, ids]) => ({ l: `${(TARGET_LABELS[t] ?? t).replace(/^./, c => c.toUpperCase())} imported`, v: num(ids.length) })),
      { l: 'Updated', v: num(Object.values(res.updated ?? {}).reduce((a, n) => a + n, 0)) }, { l: 'Duplicates skipped', v: num(res.skipped) }, { l: 'Rows with errors', v: <span style={{ color: res.errors ? C.ba : undefined }}>{num(res.errors)}</span> }]
      .map(x => ({ ...x, kpi: 'transfer.import', kpiQuery: { tenant_id: m.tenant.id, q: m.project } }))} /></div>}
    {d && <Table head={['Object', { t: 'Records', r: true }, { t: 'Warnings', r: true }, { t: 'Errors', r: true }, { t: 'Duplicates', r: true }, 'Top issue']} minWidth={620}>{d.objects.map(o =>
      <tr key={o.dataset}><td>{o.dataset} → {o.target}</td><td className="text-right">{num(o.records)}</td><td className="text-right">{o.warnings}</td><td className="text-right">{o.errors}</td><td className="text-right">{o.duplicates}</td><td>{o.top_issue}</td></tr>)}</Table>}
    {m.error && <Note className="mt-2">{m.error}</Note>}
    {m.rollback_until && <small className="mt-1.5 block" style={{ color: C.mu }}>Rollback available until {fd(m.rollback_until)}.</small>}
  </BwModal>
}

function ConnectorModal({ c, onClose, onSaved }: { c: MigrationConnector; onClose: () => void; onSaved: (c: MigrationConnector) => void }) {
  const { success, error: showError } = useToast()
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(c.fields.map(f => [f.key, f.secret ? '' : f.value ?? ''])))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const { data } = await platformApi.saveConnector(c.source, values)
      onSaved(data)
      if (data.status === 'connected') { success(data.detail || 'Connected'); onClose() } else showError(data.detail || 'Connection failed')
    } catch (err) { showError(errMsg(err, 'Unable to save the connector')) } finally { setBusy(false) }
  }
  return <BwModal title={`Connect ${c.source}`} width={520} onClose={onClose} foot={<><Btn onClick={onClose}>Cancel</Btn><Btn p disabled={busy} onClick={() => void save()}>{busy ? 'Testing connection…' : 'Save & test connection'}</Btn></>}>
    <div className="space-y-2.5">
      <Field label="Connection method"><input className={inputCls} style={inputStyle} disabled value={c.method} /></Field>
      {c.fields.map(f => <Field key={f.key} label={f.label}><input className={inputCls} style={inputStyle} type={f.secret ? 'password' : 'text'} autoComplete="off"
        placeholder={f.secret && f.set ? '•••••••• saved – leave blank to keep' : ''} value={values[f.key] ?? ''} onChange={e => setValues({ ...values, [f.key]: e.target.value })} /></Field>)}
      {c.status === 'failed' && <Note>{c.detail}</Note>}
      <Note info>The credentials are checked against {c.source} right away and stored encrypted. Access is read-only: migrations never write to {c.source}.</Note>
    </div>
  </BwModal>
}

export default function PlatformDataTransferPage() {
  const { can } = usePlatformAccess()
  const canManage = can('data_transfer', 'manage')
  const { success, error: showError } = useToast()
  const [tab, setTab] = useState<typeof TABS[number]>('Tenant exports')
  const [data, setData] = useState<DataTransferOverview | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<{ kind: 'export' } | { kind: 'migration'; row: MigrationRowT | null } | { kind: 'link' | 'checksum'; job: ExportRow } | { kind: 'report'; m: MigrationRowT } | { kind: 'connector'; c: MigrationConnector } | null>(null)
  const [busy, setBusy] = useState('')

  const seq = useRef(0)
  const load = useCallback(async () => {
    const mine = ++seq.current
    try { const { data: next } = await platformApi.dataTransferOverview(); if (mine === seq.current) { setData(next); setError('') } }
    catch (err) { if (mine === seq.current) setError(errMsg(err, 'Data export & migration unavailable')) }
  }, [])
  const active = !!data && (data.exports.some(j => j.status === 'queued' || j.status === 'running') || data.migrations.some(m => ACTIVE.includes(m.status)))
  useEffect(() => {
    void load()
    const t = window.setInterval(() => { if (!document.hidden) void load() }, active ? 2500 : 30_000)
    return () => window.clearInterval(t)
  }, [load, active])
  const close = useCallback(() => setModal(null), [])
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key)
    try { await fn(); success(done); await load() } catch (err) { showError(errMsg(err, 'Action failed')) } finally { setBusy('') }
  }
  const tenants = data?.tenants ?? []
  const firstTenant = tenants[0]?.id ?? 0

  const exportCols: GridCol<ExportRow>[] = [
    { k: 'job', t: 'Job', w: 96, sv: j => j.id, txt: j => j.job, fn: j => <b>{j.job}</b> },
    { k: 'tn', t: 'Tenant', w: 200, sv: j => j.tenant.name, txt: j => j.tenant.name, fn: j => j.tenant.name },
    { k: 'scope', t: 'Scope', sv: j => j.components.length, txt: j => j.components.length === COMPONENTS ? 'Full tenant' : `${j.components.length} of ${COMPONENTS} components`, fn: j => j.components.length === COMPONENTS ? 'Full tenant' : `${j.components.length} of ${COMPONENTS} components` },
    { k: 'fmt', t: 'Format', sv: j => j.format, txt: j => formatShort(j.format), fn: j => <span title={`${j.format} · ${j.encryption} · personal data: ${j.pii}`}>{formatShort(j.format)}</span> },
    { k: 'st', t: 'Status', w: 110, sv: j => j.status, txt: j => j.status, fn: j => j.status === 'queued' || j.status === 'running' ? <Pill t="inf">{j.status === 'queued' ? 'Queued' : 'Running'}</Pill> : j.file_available === false ? <Pill t="ba" title="The package file is no longer in export storage – retry the export">File missing</Pill> : exportPill(j) },
    { k: 'p', t: 'Progress', w: 130, sv: j => j.progress, txt: j => `${j.progress}%`, fn: j => bar(j.progress) },
    { k: 'mb', t: 'Size', sv: j => j.size_bytes ?? j.estimated_bytes ?? 0, txt: j => sizeText(j.size_bytes ?? j.estimated_bytes),
      fn: j => j.size_bytes != null ? <span title={j.file_sha256 ? `Stored file SHA-256 ${j.file_sha256}` : undefined}>{sizeText(j.size_bytes)}</span>
        : j.estimated_bytes != null && (j.status === 'queued' || j.status === 'running') ? <span style={{ color: C.mu }} title="Estimated from the selected tables and files – the final size is shown when the package is ready">≈ {sizeText(j.estimated_bytes)}</span> : '—' },
    { k: 'by', t: 'Requested by', sv: j => j.requested_by ?? '', txt: j => j.requested_by ?? '', fn: j => j.requested_by ?? '—' },
    { k: 'at', t: 'Date', sv: j => j.created_at, txt: j => fd(j.created_at), fn: j => fd(j.created_at) },
    { k: 'x', t: '', w: 200, txt: () => '', fn: j => j.status === 'ready' && j.file_available !== false ? <span className="whitespace-nowrap"><Btn s p onClick={() => setModal({ kind: 'link', job: j })}>Get link</Btn> <Btn s onClick={() => setModal({ kind: 'checksum', job: j })}>Checksum</Btn></span>
      : (j.status === 'failed' || j.status === 'expired' || j.file_available === false) && canManage ? <span title={j.error ?? (j.file_available === false ? 'The package file is no longer in export storage' : undefined)}><Btn s disabled={busy === `x${j.id}`} onClick={() => void run(`x${j.id}`, () => platformApi.retryExport(j.tenant.id, j.id), `${j.job} restarted`)}>Retry</Btn></span>
      : j.status === 'queued' || j.status === 'running' ? <small style={{ color: C.mu }}>Link &amp; checksum when ready</small> : null },
  ]
  const objectsOf = (m: MigrationRowT) => m.status === 'Fetching' ? m.pull?.objects.length ?? 0 : Object.values(m.mapping ?? {}).filter(c => c.enabled && c.target).length || m.datasets.length
  const action = (m: MigrationRowT) => {
    if (m.status === 'Completed' || m.status === 'Rolled back') return <Btn s onClick={() => setModal({ kind: 'report', m })}>Report</Btn>
    if (!canManage) return null
    if (m.status === 'Running') return <Btn s disabled={busy === `p${m.id}`} onClick={() => void run(`p${m.id}`, () => platformApi.pauseMigration(m.tenant.id, m.id), `${m.project} pausing at the next checkpoint`)}>Pause</Btn>
    if (['Paused', 'Interrupted'].includes(m.status) || (m.status === 'Failed' && m.dry_run)) return <span className="whitespace-nowrap"><Btn s p disabled={busy === `r${m.id}`} onClick={() => void run(`r${m.id}`, () => platformApi.resumeMigration(m.tenant.id, m.id), `${m.project} resumed`)}>Resume</Btn> <Btn s onClick={() => setModal({ kind: 'report', m })}>Report</Btn></span>
    if (m.status === 'Dry run passed') return <Btn s p onClick={() => setModal({ kind: 'migration', row: m })}>{m.scheduled_at ? `Cut-over ${fdt(m.scheduled_at)}` : 'Schedule cut-over'}</Btn>
    if (m.status === 'Failed') return <Btn s onClick={() => setModal({ kind: 'report', m })}>Report</Btn>
    return <Btn s onClick={() => setModal({ kind: 'migration', row: m })}>{m.status === 'Fetching' ? 'Pulling…' : 'Continue'}</Btn>
  }
  const migCols: GridCol<MigrationRowT>[] = [
    { k: 'id', t: 'Project', w: 96, sv: m => m.id, txt: m => m.project, fn: m => <b>{m.project}</b> },
    { k: 'tn', t: 'Target tenant', w: 200, sv: m => m.tenant.name, txt: m => m.tenant.name, fn: m => m.tenant.name },
    { k: 'src', t: 'Source CRM', sv: m => m.source, txt: m => m.source, fn: m => <Pill t="ac">{m.source}</Pill> },
    { k: 'objs', t: 'Objects', r: true, sv: objectsOf, txt: m => String(objectsOf(m)), fn: m => objectsOf(m) },
    { k: 'rec', t: 'Records', r: true, sv: m => m.records ?? 0, txt: m => String(m.records ?? ''), fn: m => m.records == null ? '—' : num(m.records) },
    { k: 'st', t: 'Status', w: 120, sv: m => m.status, txt: m => m.status, fn: m => <Pill t={migTone(m.status)} title={m.error ?? undefined}>{m.status}</Pill> },
    { k: 'p', t: 'Progress', w: 130, sv: m => m.progress, txt: m => `${m.progress}%`, fn: m => bar(m.status === 'Completed' ? 100 : m.progress) },
    { k: 'at', t: 'Started', sv: m => m.created_at, txt: m => fd(m.created_at), fn: m => fd(m.created_at) },
    { k: 'x', t: '', w: 190, txt: () => '', fn: action },
  ]

  const connStatus = (c: MigrationConnector) => c.status === 'connected' ? <Pill t="ok">Connected</Pill> : c.status === 'ready' ? <Pill t="ok">Ready</Pill> : c.status === 'failed' ? <Pill t="ba">Failed</Pill> : <Pill t="mu">Not configured</Pill>
  const canConfigure = canManage && !!data?.all_scope

  let body
  if (!data) body = <Panel title={tab}><Empty>{error || 'Loading…'}</Empty></Panel>
  else if (tab === 'Tenant exports') body = <>
    <div className="mb-2 flex flex-wrap items-center gap-2.5"><div><h1 className="text-xl font-semibold">Tenant data export</h1><div style={{ color: C.mu }}>Export a tenant’s complete data for portability, legal requests or offboarding.</div></div><span className="flex-1" />
      {canManage && <Btn p disabled={!tenants.length} onClick={() => setModal({ kind: 'export' })}><Ic n="plus" /> New export</Btn>}</div>
    <Panel title="Export jobs" flush><BwGrid id="dx-exports" cols={exportCols} rows={data.exports} rid={rowId} empty="No exports yet" /></Panel>
  </>
  else if (tab === 'Migration projects') body = <>
    <div className="mb-2 flex flex-wrap items-center gap-2.5"><div><h1 className="text-xl font-semibold">Migration from another CRM</h1><div style={{ color: C.mu }}>Assisted migrations with dry run, field mapping, scheduled cut-over and rollback.</div></div><span className="flex-1" />
      {canManage && <Btn p disabled={!tenants.length} onClick={() => setModal({ kind: 'migration', row: null })}><Ic n="plus" /> New migration</Btn>}</div>
    <Panel title="Projects" flush><BwGrid id="dx-migrations" cols={migCols} rows={data.migrations} rid={rowId} empty="No migrations yet" /></Panel>
  </>
  else body = <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{data.connectors.map(c => <Panel key={c.source} title={c.source} act={c.kind === 'api' && canConfigure ? <span className="flex gap-1">
      {c.status !== 'not_configured' && <Btn s disabled={busy === `t${c.source}`} onClick={() => void run(`t${c.source}`, async () => { const { data: r } = await platformApi.testConnector(c.source); if (r.status !== 'connected') throw new Error(r.detail ?? 'Connection failed') }, `${c.source} connection verified`)}>Test</Btn>}
      <Btn s onClick={() => setModal({ kind: 'connector', c })}>{c.status === 'not_configured' ? 'Connect' : 'Configure'}</Btn></span> : undefined}>
    <div className="mb-2 flex flex-wrap gap-1">{c.objects.map(o => <Pill key={o.name} t="mu" title={o.error ?? (o.count != null ? `${num(o.count)} records` : undefined)}>{o.name}{o.count != null ? ` · ${num(o.count)}` : ''}</Pill>)}</div>
    <div className="flex items-center gap-2"><small className="flex-1" style={{ color: C.mu }}>{c.method}</small>{connStatus(c)}</div>
    {c.kind === 'api' && c.status !== 'not_configured' && <div className="mt-1 text-[11px]" style={{ color: c.status === 'failed' ? C.ba : C.mu }}>{c.detail}{c.validated_at ? ` · checked ${fdt(c.validated_at)}` : ''}</div>}
    {c.kind === 'api' && c.status !== 'not_configured' && canConfigure && <button type="button" className="mt-1 text-[11px] hover:underline" style={{ color: C.mu }} onClick={() => void run(`d${c.source}`, () => platformApi.removeConnector(c.source), `${c.source} disconnected – stored credentials deleted`)}>Disconnect</button>}
  </Panel>)}</div>

  return <div className="page-body text-[13px]" style={{ color: C.tx }}>
    {modal?.kind === 'export' && <ExportWizard tenantId={firstTenant} tenants={tenants} onClose={close} onStarted={() => { close(); void load() }} />}
    {modal?.kind === 'migration' && <MigrationWizard tenantId={modal.row?.tenant.id ?? firstTenant} tenants={tenants} existing={modal.row} onClose={() => { close(); void load() }} onChanged={() => void load()} />}
    {modal?.kind === 'link' && <LinkModal job={modal.job} onClose={close} />}
    {modal?.kind === 'checksum' && <ChecksumModal job={modal.job} onClose={close} />}
    {modal?.kind === 'report' && <ReportModal m={modal.m} onClose={close} onChanged={() => void load()} />}
    {modal?.kind === 'connector' && <ConnectorModal c={modal.c} onClose={close} onSaved={() => void load()} />}
    <div className="mb-0.5 text-xs" style={{ color: C.mu }}>Data &amp; infrastructure</div>
    <div className="mb-2"><Tabs tabs={TABS} active={tab} onChange={t => setTab(t as typeof TABS[number])} /></div>
    {error && data && <Note className="mb-2">{error} · showing the last data received</Note>}
    {body}
  </div>
}
